export default {
  id: '05-stock-transfers',
  title: { en: 'Stock transfers', ur: 'اسٹاک ٹرانسفر' },
  scenes: [
    {
      en: 'If you run more than one site, you’ll need to move stock between them. That’s what Stock transfers is for — let’s take a look.',
      ur: 'اگر آپ ایک سے زیادہ مقامات چلاتے ہیں تو آپ کو ان کے درمیان اسٹاک منتقل کرنا پڑتا ہے۔ یہی کام Stock transfers کرتا ہے — آئیے دیکھتے ہیں۔',
    },
    {
      en: 'Let’s open Stock transfers from the side menu.',
      ur: 'آئیے سائیڈ مینو سے Stock transfers کھولتے ہیں۔',
      async run(h) {
        await h.click(h.nav('transfers'))
      },
    },
    {
      en: 'Here’s one already on its way to our Johar Town Branch — notice it’s marked "sent": the stock has left our shelf, but the branch hasn’t confirmed receiving it yet.',
      ur: 'یہاں ایک ٹرانسفر ہے جو پہلے ہی جوہر ٹاؤن برانچ کو بھیجا جا چکا ہے — دیکھیں اس کی حیثیت "sent" ہے: اسٹاک ہماری دکان سے نکل چکا ہے، لیکن برانچ نے ابھی وصولی کی تصدیق نہیں کی۔',
      async run(h) {
        await h.click(h.page.locator('tr[data-id]', { hasText: 'Johar Town Branch' }))
        await h.mark('h2 .badge')
      },
    },
    {
      en: 'Once the branch confirms they got it, we click Mark received — this just records acknowledgement, it doesn’t give that branch its own sellable stock.',
      ur: 'جب برانچ تصدیق کر دے کہ انہیں مال مل گیا، تو ہم “Mark received” پر کلک کرتے ہیں — یہ صرف وصولی کی تصدیق درج کرتا ہے، اس برانچ کو فروخت کے لیے الگ اسٹاک نہیں دیتا۔',
      async run(h) {
        await h.click(h.button('Mark received'))
      },
      gap: 600,
    },
    {
      en: 'Now let’s send a brand-new transfer. We tap New transfer to start one.',
      ur: 'اب ایک نیا ٹرانسفر بھیجتے ہیں۔ شروع کرنے کے لیے “New transfer” پر ٹیپ کرتے ہیں۔',
      async run(h) {
        await h.click(h.button('New transfer'))
      },
    },
    {
      en: 'We choose the destination — Johar Town Branch again — then search for Panadol and add it to the list.',
      ur: 'ہم منزل منتخب کرتے ہیں — ایک بار پھر جوہر ٹاؤن برانچ — پھر پانادول تلاش کر کے اسے فہرست میں شامل کرتے ہیں۔',
      async run(h) {
        await h.select(h.page.locator('select[name="to_location_id"]'), { label: 'Johar Town Branch' })
        await h.type(h.page.locator('#tr-pick input'), 'Panadol')
        await h.wait(400)
        await h.click(h.page.locator('#tr-pick .results button').first())
      },
    },
    {
      en: 'We set the quantity, then hit Send — the stock leaves our sellable inventory the moment we confirm.',
      ur: 'ہم مقدار درج کرتے ہیں، پھر “Send” دباتے ہیں — تصدیق کے ساتھ ہی اسٹاک ہماری فروخت کے لیے دستیاب انوینٹری سے نکل جاتا ہے۔',
      async run(h) {
        await h.type(h.page.locator('input[data-packs="0"]'), '2')
        await h.click(h.button('Send'))
      },
      gap: 600,
    },
    {
      en: 'One more thing worth knowing: transfers always take from the oldest batch first, same as a sale — so expiry dates stay in order. That’s stock transfers in a nutshell — check Help & tutorials any time you need a refresher.',
      ur: 'ایک اور بات جو جاننا ضروری ہے: ٹرانسفر ہمیشہ سب سے پرانے بیچ سے پہلے مال لیتا ہے، بالکل فروخت کی طرح — تاکہ ایکسپائری تاریخیں ترتیب میں رہیں۔ یہ تھا اسٹاک ٹرانسفر کا خلاصہ — جب بھی دوبارہ یاد دہانی چاہیے ہو، “Help & tutorials” دیکھ لیں۔',
    },
  ],
}
