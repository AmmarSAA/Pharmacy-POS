export default {
  id: '04-customers-and-accounts',
  title: { en: 'Customers & accounts', ur: 'کسٹمرز اور اکاؤنٹس' },
  start: 'customers',
  scenes: [
    {
      en: 'Most sales are plain cash, but regular customers — like a clinic that buys from you every week — can have an account instead: you bill them now, they pay later, and they build up loyalty points on every purchase.',
      ur: 'زیادہ تر سیلز نقد ہوتی ہیں، مگر باقاعدہ کسٹمرز — جیسے وہ کلینک جو ہر ہفتے خریداری کرتا ہے — کا اکاؤنٹ بھی بنایا جا سکتا ہے: ابھی بل بنے، ادائیگی بعد میں ہو، اور ہر خریداری پر لائلٹی پوائنٹس بھی ملتے ہیں۔',
    },
    {
      en: 'This is your customer list — phone number, loyalty points, and running balance for each one. Let’s open Shaukat Clinic, who buys on account.',
      ur: 'یہ آپ کی کسٹمرز کی فہرست ہے — فون نمبر، لائلٹی پوائنٹس، اور ہر ایک کا موجودہ بیلنس۔ آئیے Shaukat Clinic کھولتے ہیں، جو اکاؤنٹ پر خریداری کرتا ہے۔',
      async run(h) {
        await h.click(h.page.locator('tr', { hasText: 'Shaukat Clinic' }))
      },
    },
    {
      en: 'Here is their ledger — every sale billed to this account and every payment they have made, all adding up to the balance they currently owe.',
      ur: 'یہ ان کا لیجر ہے — اس اکاؤنٹ پر بل کی گئی ہر سیل اور کی گئی ہر ادائیگی، جو مل کر وہ بیلنس بناتی ہیں جو وہ اس وقت واجب الادا ہیں۔',
      async run(h) {
        await h.mark('#ledger', 2200)
      },
    },
    {
      en: 'Over in Point of sale, there is a field to link a customer account — search, pick one, choose Account as the payment method, and the sale bills straight to their balance instead of taking cash.',
      ur: 'Point of sale میں کسٹمر اکاؤنٹ جوڑنے کے لیے ایک فیلڈ موجود ہے — تلاش کریں، منتخب کریں، اور ادائیگی کا طریقہ Account چنیں، تو سیل نقد کے بجائے براہ راست اکاؤنٹ پر بل ہو جاتی ہے۔',
      async run(h) {
        await h.click(h.nav('pos'))
        await h.mark('#acct-search', 2000)
      },
    },
    {
      en: 'Let’s go back to Shaukat Clinic’s ledger to record a payment they have made toward that balance.',
      ur: 'آئیے Shaukat Clinic کے لیجر پر واپس چلتے ہیں تاکہ ان کی طرف سے کی گئی ادائیگی ریکارڈ کی جا سکے۔',
      async run(h) {
        await h.click(h.nav('customers'))
        await h.click(h.page.locator('tr', { hasText: 'Shaukat Clinic' }))
      },
    },
    {
      en: 'Record payment opens a short form — type the amount received, say five thousand rupees, pick how it was paid, and save. The balance updates immediately.',
      ur: 'Record payment ایک مختصر فارم کھولتا ہے — وصول شدہ رقم درج کریں، مثلاً پانچ ہزار روپے، ادائیگی کا طریقہ منتخب کریں، اور محفوظ کریں۔ بیلنس فوراً اپڈیٹ ہو جاتا ہے۔',
      async run(h) {
        await h.click(h.button('Record payment'))
        await h.type(h.label('Amount (Rs) *'), '5000')
        await h.click(h.button('Save payment'))
      },
      gap: 600,
    },
    {
      en: 'About those loyalty points — they build up automatically every time an account customer completes a purchase, like the points you saw on Shaukat Clinic earlier. Next time they are back, those points can be redeemed right in the cart to reduce the total — the earning and redemption rates are set once by the owner.',
      ur: 'لائلٹی پوائنٹس کی بات کریں تو — یہ ہر بار اکاؤنٹ کسٹمر کی خریداری پر خود بخود جمع ہوتے ہیں، جیسے Shaukat Clinic کے پوائنٹس آپ نے پہلے دیکھے۔ اگلی بار آنے پر یہ پوائنٹس کارٹ میں ہی استعمال ہو کر ٹوٹل کم کر سکتے ہیں — ان کی شرح مالک ایک بار سیٹنگز میں طے کرتا ہے۔',
      async run(h) {
        await h.click(h.nav('customers'))
        await h.mark(h.page.locator('tr', { hasText: 'Shaukat Clinic' }))
      },
    },
    {
      en: 'And that is how customer accounts and loyalty work — bill trusted customers now, collect payment later, and reward repeat visits automatically. Check Help & tutorials any time you want a refresher.',
      ur: 'یہی طریقہ ہے کسٹمر اکاؤنٹس اور لائلٹی پوائنٹس کا — قابلِ اعتماد کسٹمرز کو ابھی بل دیں، ادائیگی بعد میں وصول کریں، اور بار بار آنے والوں کو خود بخود انعام دیں۔ دوبارہ یاد دہانی کے لیے کسی وقت Help & tutorials دیکھ لیں۔',
    },
  ],
}
