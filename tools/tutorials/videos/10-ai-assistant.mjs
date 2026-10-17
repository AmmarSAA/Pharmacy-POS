// The in-app AI assistant: a real conversation against this demo's real data (the recorder's demo
// server runs the assistant on a scripted stand-in for the language model — see server.mjs — but
// every tool call it makes (search_products, set_product_price, find_tutorial, …) is executed for
// real, against this same seeded database).
const bot = (h) => h.page.locator('.as-msg.bot')
const send = async (h, text) => {
  await h.type('#as-input', text)
  await h.click(h.button('Send'))
}

export default {
  id: '10-ai-assistant',
  title: { en: 'The AI assistant', ur: 'اے آئی معاون' },
  scenes: [
    {
      en: "Every screen in this software has a built-in AI assistant, sitting in the corner, ready to answer questions or make a change for you.",
      ur: 'اس سافٹ ویئر کی ہر اسکرین پر ایک اے آئی معاون موجود ہے، کونے میں، سوالات کے جواب دینے یا آپ کی جگہ کوئی تبدیلی کرنے کے لیے تیار۔',
    },
    {
      en: "Tap the round button in the bottom-right corner to open it.",
      ur: 'اسے کھولنے کے لیے نیچے دائیں کونے کا گول بٹن دبائیں۔',
      async run(h) {
        await h.click('.as-fab')
        await h.wait(400)
      },
    },
    {
      en: "Type a question in plain English or Urdu, the way you'd ask a colleague. Let's ask about a medicine.",
      ur: 'انگریزی یا اردو میں، جس طرح آپ کسی ساتھی سے پوچھتے ہیں، ویسے ہی سوال لکھیں۔ چلیں ایک دوائی کے بارے میں پوچھتے ہیں۔',
      async run(h) {
        await h.pointAt('#as-input')
      },
    },
    {
      en: "\"What stock do we have of Panadol?\" — and send it.",
      ur: '"پانادول کا کتنا اسٹاک موجود ہے؟" — اور بھیج دیں۔',
      async run(h) {
        await send(h, 'What stock do we have of Panadol?')
      },
    },
    {
      en: "It really looked it up in the database just now — batches, prices, expiry — never a guess. If a question can't be answered from real data, it says so instead of making something up.",
      ur: 'اس نے ابھی واقعی ڈیٹابیس میں دیکھا — بیچ، قیمتیں، ایکسپائری — کبھی اندازہ نہیں لگاتا۔ اگر کسی سوال کا جواب حقیقی ڈیٹا سے نہ ملے تو یہ صاف بتا دیتا ہے، من گھڑت جواب نہیں دیتا۔',
      async run(h) {
        await bot(h).last().waitFor({ timeout: 15000 })
        await h.mark(bot(h).last(), 2200)
      },
    },
    {
      en: "It can make changes too — let's ask it to change a price.",
      ur: 'یہ تبدیلیاں بھی کر سکتا ہے — چلیں اس سے قیمت بدلنے کو کہتے ہیں۔',
      async run(h) {
        await send(h, "Set Panadol's pack price to Rs 30")
      },
    },
    {
      en: "Instead of just doing it, it shows exactly what will change on a card like this, and waits for you.",
      ur: 'فوراً کرنے کے بجائے، یہ ایسے ہی ایک کارڈ پر دکھاتا ہے کہ کیا بدلنے والا ہے، اور آپ کے فیصلے کا انتظار کرتا ہے۔',
      async run(h) {
        await h.page.locator('.as-card.pending').waitFor({ timeout: 15000 })
        await h.mark('.as-card.pending', 2400)
      },
    },
    {
      en: "Nothing is saved until you tap Approve — and if it's wrong, Decline and nothing happens at all.",
      ur: 'جب تک آپ منظور نہ دبائیں کچھ محفوظ نہیں ہوتا — اور اگر غلط ہو تو نامنظور کر دیں، کچھ بھی نہیں بدلتا۔',
      async run(h) {
        await h.click(h.button('Approve'))
        await h.wait(300)
      },
    },
    {
      en: "Done — the price really changed, the same as if you had edited it on the Products screen yourself.",
      ur: 'ہو گیا — قیمت واقعی بدل گئی، بالکل ایسے جیسے آپ خود پراڈکٹس کی اسکرین پر تبدیل کرتے۔',
      async run(h) {
        await h.wait(800)
        await h.mark(bot(h).last(), 1800)
      },
    },
    {
      en: "One more thing it can do: if you're not sure how to do something, just ask — it can link you straight to the right tutorial video.",
      ur: 'ایک اور کام یہ بھی کر سکتا ہے: اگر کوئی کام سمجھ نہ آئے تو صرف پوچھیں — یہ آپ کو سیدھا متعلقہ تربیتی ویڈیو تک پہنچا سکتا ہے۔',
      async run(h) {
        await send(h, 'How do I issue stock to a department?')
        await bot(h).last().waitFor({ timeout: 15000 })
      },
    },
    {
      en: "There's the link, right inside its reply. Let's tap it.",
      ur: 'اس کے جواب کے اندر ہی وہ لنک موجود ہے۔ چلیں اسے دبائیں۔',
      async run(h) {
        const link = bot(h).last().locator('a')
        await h.mark(link, 1200)
        await h.click(link)
        await h.wait(600)
      },
    },
    {
      en: "And that opens the matching tutorial right here on the Help page — the same ten videos you've been watching, always one question away, in English or Urdu, whenever you're not sure what to do next.",
      ur: 'اور یہ یہیں مدد کے صفحے پر وہی متعلقہ تربیتی ویڈیو کھول دیتا ہے — یہی دس ویڈیوز جو آپ دیکھ رہے ہیں، اردو یا انگریزی میں، ہمیشہ صرف ایک سوال کی دوری پر، جب بھی سمجھ نہ آئے کہ آگے کیا کرنا ہے۔',
    },
  ],
}
