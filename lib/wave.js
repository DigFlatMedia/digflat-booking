// Wave (waveapps.com) GraphQL integration.
// Endpoint: https://gql.waveapps.com/graphql/public
// Auth: Bearer <full-access-token>
//
// Wave requires every invoice line item to reference a saved Product.
// We auto-create a single "DigFlat Booking Service" product on first use,
// then attach descriptions per line item to itemize on the invoice.
//
// Webhook signature: X-Wave-Signature, HMAC-SHA256 hex of raw body using
// the webhook subscription secret.
import crypto from 'node:crypto';
import { readJSON, updateJSON } from './storage.js';

const ENDPOINT = 'https://gql.waveapps.com/graphql/public';
const STATE_FILE = 'wave-state.json'; // { productId, customerByEmail: {} }
const STATE_DEFAULT = { productId: null, customerByEmail: {} };

function token() {
  const t = process.env.WAVE_API_TOKEN;
  if (!t) throw new Error('WAVE_API_TOKEN not set');
  return t;
}
function businessId() {
  const b = process.env.WAVE_BUSINESS_ID;
  if (!b) throw new Error('WAVE_BUSINESS_ID not set');
  return b;
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error('Wave error: ' + JSON.stringify(data.errors || data));
  }
  return data.data;
}

export async function isConfigured() {
  return !!(process.env.WAVE_API_TOKEN && process.env.WAVE_BUSINESS_ID);
}

async function ensureProduct() {
  const state = await readJSON(STATE_FILE, STATE_DEFAULT);
  if (state.productId) return state.productId;

  // Find an income account to attach the product to (required by Wave).
  const accounts = await gql(`
    query($id: ID!) {
      business(id: $id) {
        accounts(types: [INCOME], page: 1, pageSize: 50) {
          edges { node { id name subtype { name value } } }
        }
      }
    }
  `, { id: businessId() });
  const incomeEdges = accounts.business?.accounts?.edges || [];
  // Prefer "Sales" subtype if present, otherwise first.
  const incomeAccount =
    incomeEdges.find(e => /sales/i.test(e.node.name))?.node ||
    incomeEdges[0]?.node;
  if (!incomeAccount) throw new Error('Wave business has no INCOME account configured');

  const create = await gql(`
    mutation($input: ProductCreateInput!) {
      productCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        product { id }
      }
    }
  `, {
    input: {
      businessId: businessId(),
      name: 'DigFlat Booking Service',
      description: 'Photography & videography services booked via DigFlat Media booking site.',
      unitPrice: '0.00',
      incomeAccountId: incomeAccount.id,
    },
  });

  if (!create.productCreate?.didSucceed) {
    throw new Error('productCreate failed: ' + JSON.stringify(create.productCreate?.inputErrors || create));
  }
  const productId = create.productCreate.product.id;
  await updateJSON(STATE_FILE, STATE_DEFAULT, s => ({ ...s, productId }));
  return productId;
}

async function ensureCustomer({ name, email, phone, address }) {
  const key = email.toLowerCase();
  const state = await readJSON(STATE_FILE, STATE_DEFAULT);
  if (state.customerByEmail?.[key]) return state.customerByEmail[key];

  const create = await gql(`
    mutation($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        customer { id }
      }
    }
  `, {
    input: {
      businessId: businessId(),
      name,
      email,
      mobile: phone || undefined,
      address: address ? { addressLine1: address.line1, city: address.city, postalCode: address.zip, provinceCode: address.stateCode, countryCode: 'US' } : undefined,
    },
  });

  if (!create.customerCreate?.didSucceed) {
    throw new Error('customerCreate failed: ' + JSON.stringify(create.customerCreate?.inputErrors || create));
  }
  const id = create.customerCreate.customer.id;
  await updateJSON(STATE_FILE, STATE_DEFAULT, s => {
    s.customerByEmail = { ...(s.customerByEmail || {}), [key]: id };
    return s;
  });
  return id;
}

// Create + approve an invoice. Returns { invoiceId, viewUrl, pdfUrl }.
//   customer: { name, email, phone?, address? }
//   items: [{ description, amount }]
//   memo: optional string
//   bookingId: stored in the invoice's internal note for webhook correlation
export async function createPaidInvoice({ customer, items, memo, bookingId, propertyAddress }) {
  const productId = await ensureProduct();
  const customerId = await ensureCustomer(customer);

  // Wave wants string-formatted prices.
  const lineItems = items.map(li => ({
    productId,
    description: li.description,
    quantity: '1',
    unitPrice: li.amount.toFixed(2),
  }));

  // Build internal-only note containing our booking id so the webhook
  // handler can find the right booking even if memo is edited.
  const internalNote = `bookingId=${bookingId}`;

  const create = await gql(`
    mutation($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice { id viewUrl pdfUrl status }
      }
    }
  `, {
    input: {
      businessId: businessId(),
      customerId,
      items: lineItems,
      memo: memo || `Booking for ${propertyAddress || 'photography service'}`,
      footer: `DigFlat Media booking #${bookingId}`,
      title: 'Invoice',
      invoiceNumber: `BK-${bookingId}`,
    },
  });

  if (!create.invoiceCreate?.didSucceed) {
    throw new Error('invoiceCreate failed: ' + JSON.stringify(create.invoiceCreate?.inputErrors || create));
  }
  const invoice = create.invoiceCreate.invoice;

  // Approve so the customer can pay it.
  const approve = await gql(`
    mutation($input: InvoiceApproveInput!) {
      invoiceApprove(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice { id viewUrl pdfUrl status }
      }
    }
  `, { input: { invoiceId: invoice.id } });

  if (!approve.invoiceApprove?.didSucceed) {
    throw new Error('invoiceApprove failed: ' + JSON.stringify(approve.invoiceApprove?.inputErrors || approve));
  }

  const final = approve.invoiceApprove.invoice;
  return { invoiceId: final.id, viewUrl: final.viewUrl, pdfUrl: final.pdfUrl, status: final.status, internalNote };
}

// Lookup invoice status (for the post-redirect polling page).
export async function getInvoice(invoiceId) {
  const data = await gql(`
    query($businessId: ID!, $invoiceId: ID!) {
      business(id: $businessId) {
        invoice(id: $invoiceId) {
          id status viewUrl pdfUrl amountDue { value } amountPaid { value }
        }
      }
    }
  `, { businessId: businessId(), invoiceId });
  return data.business?.invoice || null;
}

// Verify webhook signature (HMAC-SHA256 hex over raw body).
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Wave may send "sha256=..." or just hex; handle both.
  const got = signatureHeader.replace(/^sha256=/, '');
  if (got.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
  catch { return false; }
}
