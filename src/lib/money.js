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
