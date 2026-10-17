export default {
  id: '07-employees-and-appointments',
  title: { en: 'Employees & appointments', ur: 'ملازمین اور ملاقاتیں' },
  scenes: [
    {
      en: 'Running a pharmacy means managing people as well as products — who works here, and when they’re around. This video covers two screens for that: Employees, and Appointments.',
      ur: 'فارمیسی چلانے کا مطلب صرف مال نہیں بلکہ عملہ بھی سنبھالنا ہے — کون کام کرتا ہے اور کب دستیاب ہوتا ہے۔ اس ویڈیو میں دو اسکرینیں دیکھیں گے: ملازمین اور ملاقاتیں۔',
    },
    {
      en: 'Let’s open Employees, and take a look at Hassan Raza’s record — job title, phone, hire date, salary, and a linked login that ties it to his actual sign-in account.',
      ur: 'آئیے ملازمین کھولتے ہیں اور حسن رضا کا ریکارڈ دیکھتے ہیں — عہدہ، فون نمبر، تاریخ تقرری، تنخواہ، اور ایک لنکڈ لاگ ان جو اسے اس کے اصل اکاؤنٹ سے جوڑتا ہے۔',
      async run(h) {
        await h.click(h.nav('employees'))
        await h.click(h.page.locator('tr[data-id]', { hasText: 'Hassan Raza' }))
        await h.mark(h.label('Linked login (optional)'))
        await h.click(h.button('Cancel'))
      },
    },
    {
      en: 'Now let’s add someone new. We open the form and fill in the basics — name, role, contact, hire date and pay.',
      ur: 'چلیں ایک نیا ملازم شامل کرتے ہیں۔ فارم کھول کر بنیادی تفصیلات درج کرتے ہیں — نام، عہدہ، رابطہ، تاریخ تقرری اور تنخواہ۔',
      async run(h) {
        await h.click(h.button('Add employee'))
        await h.type(h.label('Full name *'), 'Ali Raza')
        await h.type(h.label('Job title'), 'Trainee Pharmacist')
        await h.type(h.label('Phone'), '0345-1122334')
        const hire = h.page.locator('input[name="hire_date"]')
        await h.click(hire)
        await hire.fill(new Date().toISOString().slice(0, 10))
        await h.type(h.label('Salary (Rs/month)'), '40000')
        await h.click(h.button('Save'))
      },
      gap: 600,
    },
    {
      en: 'Next, Appointments. Everyone can manage their own, but some roles — like the owner or a pharmacist — can also book for others, which is handy for building out a week’s roster.',
      ur: 'اب ملاقاتیں۔ ہر کوئی اپنی ملاقاتیں خود منظم کر سکتا ہے، لیکن کچھ کردار — جیسے مالک یا فارماسسٹ — دوسروں کے لیے بھی بک کر سکتے ہیں، جو ایک ہفتے کا شیڈول بنانے کے لیے مفید ہے۔',
      async run(h) {
        await h.click(h.nav('appointments'))
      },
    },
    {
      en: 'There’s already a stock audit booked for tomorrow with the supplier — start time, end time and notes, all visible at a glance.',
      ur: 'کل سپلائر کے ساتھ اسٹاک آڈٹ پہلے سے طے ہے — شروع اور اختتامی وقت، اور نوٹس، سب ایک ہی نظر میں نظر آتے ہیں۔',
      async run(h) {
        await h.mark(h.page.locator('tr', { hasText: 'Stock audit with supplier' }))
      },
    },
    {
      en: 'Let’s book a brand-new one live — an evening counter shift for Sara, two days from now.',
      ur: 'چلیں ابھی ایک نئی ملاقات بک کرتے ہیں — سارہ کی کاؤنٹر شفٹ، آج سے دو دن بعد کی شام۔',
      async run(h) {
        await h.click(h.button('New'))
        await h.type(h.label('Title *'), 'Evening counter shift')
        await h.select(h.page.locator('select[name="kind"]'), 'shift')
        const d = new Date()
        d.setDate(d.getDate() + 2)
        const iso = d.toISOString().slice(0, 10)
        const start = h.page.locator('input[name="starts_at"]')
        await h.click(start)
        await start.fill(`${iso}T16:00`)
        const end = h.page.locator('input[name="ends_at"]')
        await h.click(end)
        await end.fill(`${iso}T20:00`)
        await h.select(h.page.locator('select[name="with_user_id"]'), { label: 'Sara Malik' })
        await h.click(h.button('Save'))
      },
      gap: 600,
    },
    {
      en: 'That’s Employees and Appointments — one is about who’s on your team, the other about when they’re around. Together they keep your people organised, separate from stock and money. Check Help & tutorials any time you need a refresher.',
      ur: 'یہ تھیں ملازمین اور ملاقاتیں کی اسکرینیں — ایک یہ بتاتی ہے کہ آپ کی ٹیم میں کون ہے، دوسری یہ کہ وہ کب دستیاب ہیں۔ دونوں مل کر آپ کے عملے کو منظم رکھتی ہیں، اسٹاک اور پیسے سے الگ۔ جب بھی یاد دہانی چاہیے ہو، Help & tutorials دیکھ لیں۔',
    },
  ],
}
