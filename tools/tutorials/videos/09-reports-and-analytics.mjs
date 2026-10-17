export default {
  id: '09-reports-and-analytics',
  title: { en: 'Reports & analytics', ur: 'رپورٹس اور تجزیات' },
  start: 'reports',
  scenes: [
    {
      en: 'Reports is where you check the numbers — sales summary, top sellers, low stock, expiry, and what you owe your suppliers, all over a date range you pick.',
      ur: 'رپورٹس وہ جگہ ہے جہاں آپ اعداد و شمار دیکھتے ہیں — سیلز کا خلاصہ، بہترین فروخت ہونے والی اشیاء، کم اسٹاک، ایکسپائری، اور سپلائرز کو واجب الادا رقم — سب ایک منتخب تاریخ کی حد کے ساتھ۔',
    },
    {
      en: 'This is Sales summary — invoices, net sales, discounts and gross profit, all for today by default.',
      ur: 'یہ سیلز کا خلاصہ ہے — انوائسز، خالص سیلز، رعایتیں اور مجموعی منافع، بطور ڈیفالٹ آج کے لیے۔',
      async run(h) {
        await h.mark('.cards')
      },
    },
    {
      en: 'Switching to Top products shows exactly what’s selling, and how much profit each one made.',
      ur: 'ٹاپ پراڈکٹس پر جانے سے پتا چلتا ہے کہ کیا سب سے زیادہ فروخت ہو رہا ہے، اور ہر ایک سے کتنا منافع ہوا۔',
      async run(h) {
        await h.click(h.button('Top products'))
        await h.mark(h.page.locator('tr', { hasText: 'Panadol' }).first())
      },
    },
    {
      en: 'And Low stock flags anything that’s dropped below its reorder level, so you never run out.',
      ur: 'اور لو اسٹاک ہر اس چیز کی نشاندہی کرتا ہے جو اپنی ری آرڈر سطح سے نیچے جا چکی ہو، تاکہ اسٹاک ختم نہ ہو۔',
      async run(h) {
        await h.click(h.button('Low stock'))
        await h.mark('#out')
      },
    },
    {
      en: 'Analytics shows that same kind of information, but as charts, over whatever date range you choose.',
      ur: 'تجزیات یا Analytics وہی معلومات دکھاتا ہے، مگر چارٹس کی صورت میں، آپ کی منتخب کردہ تاریخ کی حد کے دوران۔',
      async run(h) {
        await h.click(h.nav('analytics'))
      },
    },
    {
      en: 'Here’s sales by day, and a breakdown of top products and payment methods — cash, card, wallet and account sales side by side.',
      ur: 'یہ ہے روزانہ سیلز کا چارٹ، اور بہترین مصنوعات اور ادائیگی کے طریقوں کی تفصیل — نقد، کارڈ، والیٹ اور اکاؤنٹ کی فروخت ایک ساتھ۔',
      async run(h) {
        await h.mark(h.page.locator('.panel', { hasText: 'Sales by day' }))
        await h.mark(h.page.locator('.panel', { hasText: 'By payment method' }))
      },
    },
    {
      en: 'Just change the From and To dates at the top, and every number and chart updates to match. That’s Reports and Analytics in a nutshell — check Help & tutorials any time you need a refresher.',
      ur: 'صرف اوپر From اور To تاریخیں بدلیں، اور ہر عدد اور چارٹ خود بخود اس کے مطابق تبدیل ہو جائے گا۔ یہ تھا رپورٹس اور تجزیات کا خلاصہ — جب بھی یاد دہانی چاہیے ہو، Help & tutorials دیکھ لیں۔',
    },
  ],
}
