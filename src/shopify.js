// Client Shopify Admin API (GraphQL). Lecture seule : commandes, client, fulfillment, tracking.
import { config } from './config.js';

async function gql(query, variables = {}) {
  const { shop, token, apiVersion } = config.shopify;
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors)}`);
  return data.data;
}

const ORDER_FIELDS = `
  id
  name
  processedAt
  createdAt
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  email
  customer { firstName lastName email }
  shippingAddress { name address1 address2 zip city province country phone }
  lineItems(first: 30) {
    nodes {
      title
      quantity
      variantTitle
      sku
    }
  }
  fulfillments(first: 10) {
    status
    createdAt
    updatedAt
    trackingInfo { number company url }
    estimatedDeliveryAt
    displayStatus
    events(first: 20) {
      nodes { status happenedAt message }
    }
  }
  refunds(first: 5) { createdAt note totalRefundedSet { presentmentMoney { amount currencyCode } } }
`;

function mapOrder(o) {
  if (!o) return null;
  return {
    orderNumber: o.name,
    date: o.processedAt || o.createdAt,
    cancelledAt: o.cancelledAt,
    financialStatus: o.displayFinancialStatus,     // PAID, REFUNDED, PARTIALLY_REFUNDED…
    fulfillmentStatus: o.displayFulfillmentStatus, // UNFULFILLED, FULFILLED, IN_TRANSIT…
    email: o.email,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' '),
    shippingAddress: o.shippingAddress,
    items: (o.lineItems?.nodes || []).map(li => ({
      title: li.title, quantity: li.quantity, variant: li.variantTitle, sku: li.sku,
    })),
    fulfillments: (o.fulfillments || []).map(f => ({
      status: f.displayStatus || f.status,
      updatedAt: f.updatedAt,
      estimatedDeliveryAt: f.estimatedDeliveryAt,
      tracking: (f.trackingInfo || []).map(t => ({ number: t.number, carrier: t.company, url: t.url })),
      events: (f.events?.nodes || []).map(e => ({ status: e.status, at: e.happenedAt, message: e.message })),
    })),
    refunds: (o.refunds || []).map(r => ({
      createdAt: r.createdAt,
      note: r.note,
      amount: r.totalRefundedSet?.presentmentMoney?.amount,
      currency: r.totalRefundedSet?.presentmentMoney?.currencyCode,
    })),
  };
}

// Recherche par requête Shopify (email, name:#1234, etc.)
async function searchOrders(searchQuery) {
  const data = await gql(
    `query($q: String!) {
       orders(first: 5, query: $q, sortKey: PROCESSED_AT, reverse: true) {
         nodes { ${ORDER_FIELDS} }
       }
     }`,
    { q: searchQuery },
  );
  return (data.orders?.nodes || []).map(mapOrder);
}

// Recherche multi-critères, la plus récente d'abord. Retourne { order, candidates }.
export async function findOrder({ email, orderNumber, customerName }) {
  // 1) par numéro de commande (le plus fiable)
  if (orderNumber) {
    const clean = String(orderNumber).replace(/[^0-9]/g, '');
    if (clean) {
      const byName = await searchOrders(`name:#${clean}`);
      if (byName.length) return { order: byName[0], candidates: byName, matchedBy: 'orderNumber' };
    }
  }
  // 2) par email
  if (email) {
    const byEmail = await searchOrders(`email:${email}`);
    if (byEmail.length) return { order: byEmail[0], candidates: byEmail, matchedBy: 'email' };
  }
  // 3) par nom du client (recherche plein-texte Shopify)
  if (customerName) {
    const byName = await searchOrders(customerName.trim());
    if (byName.length) return { order: byName[0], candidates: byName, matchedBy: 'customerName' };
  }
  return { order: null, candidates: [], matchedBy: null };
}
