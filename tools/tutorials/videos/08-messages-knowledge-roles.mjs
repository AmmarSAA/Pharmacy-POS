export default {
  id: '08-messages-knowledge-roles',
  title: { en: 'Messages, knowledge & roles', ur: 'پیغامات، نالج اور کردار' },
  scenes: [
    {
      en: 'This video covers three screens about how your team communicates and who can do what: Messages, Knowledge, and Roles.',
      ur: 'اس ویڈیو میں تین اسکرینیں دیکھیں گے جو آپ کی ٹیم کے رابطے اور اختیارات سے متعلق ہیں: پیغامات، نالج، اور کردار۔',
    },
    {
      en: 'Messages are simple internal direct messages between staff — not a broadcast channel. Here’s the conversation with Hassan about checking a batch before closing.',
      ur: 'پیغامات عملے کے درمیان سادہ براہِ راست گفتگو ہیں — کوئی نشریاتی چینل نہیں۔ یہ حسن کے ساتھ بیچ چیک کرنے کے بارے میں گفتگو ہے۔',
      async run(h) {
        await h.click(h.nav('messages'))
        await h.click(h.text('Hassan Raza'))
      },
    },
    {
      en: 'Let’s start a brand-new conversation — with Sara, about tonight’s closing count.',
      ur: 'چلیں ایک نئی گفتگو شروع کرتے ہیں — سارہ کے ساتھ، آج رات کی کلوزنگ کاؤنٹ کے بارے میں۔',
      async run(h) {
        await h.select(h.page.locator('select[name="to_user_id"]'), { label: 'Sara Malik (cashier)' })
        await h.click(h.button('Start a new conversation'))
        await h.type(h.page.locator('input[name="body"]'), 'Please recount the drawer before you leave tonight.')
        await h.click(h.button('Send'))
      },
      gap: 600,
    },
    {
      en: 'Next, Knowledge — a shared procedure book everyone can read, though only some roles can write to it. Here’s the controlled-drug checklist already on file.',
      ur: 'اب نالج — ایک مشترکہ ہدایت نامہ جو سب پڑھ سکتے ہیں، مگر لکھنے کی اجازت صرف کچھ کرداروں کو ہے۔ یہ کنٹرولڈ دوا کی چیک لسٹ پہلے سے موجود ہے۔',
      async run(h) {
        await h.click(h.nav('knowledge'))
        await h.click(h.page.locator('tr[data-id]', { hasText: 'Controlled drug dispensing checklist' }))
      },
    },
    {
      en: 'Let’s close this, and write a brand-new one — a quick checklist for handling cold-chain stock.',
      ur: 'اسے بند کرتے ہیں اور ایک نیا آرٹیکل لکھتے ہیں — کولڈ چین اسٹاک سنبھالنے کے لیے ایک مختصر چیک لسٹ۔',
      async run(h) {
        await h.click(h.button('Close'))
        await h.click(h.button('New article'))
        await h.type(h.label('Title *'), 'Cold-chain storage checklist')
        await h.type(h.label('Tags (comma separated)'), 'storage, compliance')
        await h.type(h.label('Body'), '1. Check fridge temperature twice a day.\n2. Log any reading outside 2-8C.\n3. Report a breach to the pharmacist immediately.')
        await h.click(h.button('Save'))
      },
      gap: 600,
    },
    {
      en: 'Now, Roles. There are three built-in ones — admin, pharmacist and cashier — each with a fixed set of permissions. Need something in between? Build a custom one.',
      ur: 'اب کردار۔ تین پہلے سے موجود کردار ہیں — ایڈمن، فارماسسٹ اور کیشیئر — ہر ایک کی اپنی مخصوص اجازتیں ہیں۔ اگر کچھ درمیانی درجے کا کردار چاہیے ہو؟ ایک نیا کردار بنائیں۔',
      async run(h) {
        await h.click(h.nav('roles'))
        await h.mark(h.page.locator('tr', { hasText: 'Built-in' }).first())
      },
    },
    {
      en: 'Let’s build one — a Senior Cashier, who can also process returns and view reports, without full admin access.',
      ur: 'چلیں ایک بناتے ہیں — سینئر کیشیئر، جو واپسی کا عمل بھی کر سکے اور رپورٹس بھی دیکھ سکے، مگر مکمل ایڈمن رسائی کے بغیر۔',
      async run(h) {
        await h.click(h.button('New role'))
        await h.type(h.label('Name *'), 'Senior Cashier')
        await h.click(h.label('Process returns & refunds'))
        await h.click(h.label('View reports & BI dashboards'))
        await h.click(h.button('Save'))
      },
      gap: 600,
    },
    {
      en: 'Once a custom role is saved, you assign it to someone from the Users screen. That covers Messages, Knowledge and Roles — check Help & tutorials any time you need a refresher.',
      ur: 'نیا کردار محفوظ ہونے کے بعد، اسے صارفین کی اسکرین سے کسی کو تفویض کر دیں۔ یہی تھیں پیغامات، نالج اور کردار کی اسکرینیں — جب بھی یاد دہانی چاہیے ہو، Help & tutorials دیکھ لیں۔',
    },
  ],
}
