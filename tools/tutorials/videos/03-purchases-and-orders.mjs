export default {
  id: '03-purchases-and-orders',
  title: { en: 'Purchases & purchase orders', ur: 'خریداریاں اور پرچیز آرڈرز' },
  start: 'purchases',
  scenes: [
    {
      en: 'Every time stock arrives, you record it here in Purchases — and when you want to order ahead from a supplier before the delivery even shows up, that is what Purchase Orders are for. Let’s walk through both.',
      ur: 'جب بھی مال پہنچے، آپ اسے یہاں Purchases میں درج کرتے ہیں — اور جب ڈیلیوری سے پہلے ہی سپلائر کو آرڈر دینا ہو تو اس کے لیے Purchase Orders ہیں۔ آئیے دونوں دیکھتے ہیں۔',
    },
    {
      en: 'This is the Purchases screen — every delivery you have actually received from a supplier gets logged here, with cost and stock updated the moment you save.',
      ur: 'یہ Purchases اسکرین ہے — سپلائر سے موصول ہونے والی ہر ڈیلیوری یہاں درج ہوتی ہے، اور محفوظ کرتے ہی لاگت اور اسٹاک اپڈیٹ ہو جاتے ہیں۔',
      async run(h) {
        await h.mark('#list', 2200)
      },
    },
    {
      en: 'Tap New purchase when a delivery truck arrives, and pick the supplier it came from — here, City Pharma Distributors.',
      ur: 'جب ڈیلیوری آئے تو New purchase پر کلک کریں، اور وہ سپلائر منتخب کریں جس سے سامان آیا — یہاں، City Pharma Distributors۔',
      async run(h) {
        await h.click(h.button('New purchase'))
        await h.select(h.page.locator('select[name="supplier_id"]'), { label: 'City Pharma Distributors' })
      },
    },
    {
      en: 'Type the medicine name — Brufen — and it is matched from your product list automatically. Then note the batch number and the expiry date straight off the pack.',
      ur: 'دوا کا نام لکھیں — Brufen — یہ خود بخود آپ کی فہرست سے مل جاتی ہے۔ پھر پیکٹ پر موجود بیچ نمبر اور ایکسپائری تاریخ درج کریں۔',
      async run(h) {
        // .fill(), not h.type(): this field resolves-as-you-type (it rewrites its own value to the
        // matched product partway through typing a short, unambiguous name like "Brufen"), which
        // races character-by-character typing and corrupts the field. A single programmatic fill
        // still fires the real input event the match logic listens for, with no race.
        const product = h.label('Product')
        await h.click(product)
        await product.fill('Brufen')
        await h.wait(250)
        await h.type(h.label('Batch'), 'BR-2210')
        const expiry = h.label('Expiry')
        await h.click(expiry)
        await expiry.fill('2028-06-30')
      },
    },
    {
      en: 'Enter how many packs arrived and what each pack cost you, then Save & add to stock — the stock lands on your shelf and is ready to sell right away.',
      ur: 'کتنے پیک آئے اور ہر پیک کی قیمت کیا تھی درج کریں، پھر Save & add to stock دبائیں — اسٹاک فوراً شیلف میں شامل ہو کر فروخت کے لیے تیار ہو جاتا ہے۔',
      async run(h) {
        await h.type(h.label('Packs'), '10')
        await h.type(h.label('Pack cost'), '47')
        // Blur the last field first — a lingering native date-picker/autocomplete popup from an
        // earlier field can otherwise intercept the click on Save. Scoped to the modal itself: the
        // list screen's own "New purchase" button sits right behind the modal backdrop and is a
        // same-text trap for an unscoped locator.
        await h.click(h.page.locator('.modal h2', { hasText: 'New purchase' }))
        await h.wait(300)
        const save = h.button('Save & add to stock')
        await h.pointAt(save)
        try {
          await save.click({ timeout: 8000 })
        } catch {
          await save.click({ force: true })
        }
        // Saving posts to the API before the modal closes itself; wait for it to actually be gone
        // so the next scene doesn't try to click through a still-open modal backdrop.
        await h.page.locator('.modal-bg').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
      },
      gap: 600,
    },
    {
      en: 'Now, Purchase Orders — this is for planning ahead. You place an order with a supplier before anything physically arrives, so you both know what is coming.',
      ur: 'اب Purchase Orders — یہ پہلے سے منصوبہ بندی کے لیے ہے۔ سامان پہنچنے سے پہلے ہی سپلائر کو آرڈر دیا جاتا ہے، تاکہ دونوں کو معلوم رہے کیا آنے والا ہے۔',
      async run(h) {
        await h.click(h.nav('purchase-orders'))
      },
    },
    {
      en: 'Here is one already sent to MediCore Pakistan — fifteen packs of Brufen and ten of Risek, expected in a few days. Let’s open it.',
      ur: 'یہ ایک آرڈر ہے جو MediCore Pakistan کو بھیجا جا چکا ہے — پندرہ پیک Brufen اور دس پیک Risek کے، جو چند دنوں میں متوقع ہیں۔ آئیے اسے کھولتے ہیں۔',
      async run(h) {
        await h.click(h.page.locator('tr', { hasText: 'MediCore Pakistan' }))
      },
    },
    {
      en: 'Its status is “sent” — placed but not yet received. When the delivery turns up, you would open it from here and hit Receive stock, which fills in a purchase for you and marks this order received automatically.',
      ur: 'اس کی حیثیت “sent” ہے — آرڈر دیا جا چکا مگر وصول نہیں ہوا۔ جب ڈیلیوری پہنچے تو یہاں سے Receive stock پر کلک کریں، جو خود بخود ایک پرچیز بنا کر اس آرڈر کو موصول شدہ قرار دے دیتا ہے۔',
      async run(h) {
        await h.mark(h.page.locator('.badge', { hasText: 'sent' }).first())
        await h.mark(h.button('Receive stock'))
      },
      gap: 500,
    },
    {
      en: 'One more thing — Suppliers keeps track of exactly how much you owe each one, like City Pharma Distributors here, and lets you record a payment whenever you settle up. That covers purchases and purchase orders — check Help & tutorials any time for a refresher.',
      ur: 'ایک اور بات — Suppliers ہر سپلائر کی واجب الادا رقم کا حساب رکھتا ہے، جیسے یہاں City Pharma Distributors، اور جب ادائیگی کریں تو اسے ریکارڈ بھی کر سکتے ہیں۔ یہ تھیں Purchases اور Purchase Orders — دوبارہ یاد دہانی کے لیے کسی وقت Help & tutorials دیکھ لیں۔',
      async run(h) {
        await h.click(h.button('Close'))
        await h.click(h.nav('suppliers'))
        await h.mark(h.page.locator('tr', { hasText: 'City Pharma Distributors' }))
      },
      gap: 600,
    },
  ],
}
