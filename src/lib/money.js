// Money is integer paisa, rates are basis points.

export function percentOf(amount, bps) {
  return Math.round((amount * bps) / 10000)
}

// GST contained in a tax-inclusive amount (retail medicine prices in Pakistan are MRP, tax inclusive).
export function inclusiveTax(amount, rateBps) {
  if (!rateBps) return 0
  return Math.round((amount * rateBps) / (10000 + rateBps))
}

export function roundToRupee(amount) {
  return Math.round(amount / 100) * 100
}

// Amount for `qty` units when a full pack of `packSize` units costs `packPrice`.
// Whole packs come out exact; loose units are priced pro rata and rounded to the paisa.
export function packAmount(qty, packPrice, packSize) {
  return Math.round((qty * packPrice) / (packSize || 1))
}

// Sale price that gives `marginBps` margin on `cost` (margin = profit / sale price).
export function priceForMargin(cost, marginBps) {
  if (marginBps >= 10000) return cost
  return Math.round((cost * 10000) / (10000 - marginBps))
}
