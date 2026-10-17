export default {
  id: '06-departments-and-issues',
  title: { en: 'Departments & issues', ur: 'شعبے اور اشیاء کا اجراء' },
  scenes: [
    {
      en: 'Hospitals often draw medicine straight from the pharmacy for a ward, instead of buying it like a retail customer. This screen — Issues and Departments — tracks exactly what each department takes, valued at cost, and kept separate from your till sales.',
      ur: 'اکثر ہسپتالوں میں وارڈز دوا براہ راست فارمیسی سے لیتے ہیں، عام گاہک کی طرح خرید کر نہیں۔ یہ اسکرین — Issues اور Departments — ہر شعبے کی لی گئی دوا کو، لاگت کے حساب سے، اور ٹل کی فروخت سے الگ ریکارڈ کرتی ہے۔',
    },
    {
      en: 'Let’s open the Issues screen from the side menu.',
      ur: 'آئیے سائیڈ مینو سے Issues اسکرین کھولتے ہیں۔',
      async run(h) {
        await h.click(h.nav('issues'))
      },
    },
    {
      en: 'First, the Requisitions tab — this is where a department’s request for medicine gets logged before anything is handed over.',
      ur: 'پہلے Requisitions ٹیب — یہاں کسی شعبے کی دوا کی درخواست درج ہوتی ہے، مال دینے سے پہلے۔',
      async run(h) {
        await h.click(h.button('Requisitions'))
      },
    },
    {
      en: 'Here’s one already finished — Emergency Ward asked for Panadol and Brufen, and it shows fully issued, with nothing left owed.',
      ur: 'یہاں ایک مکمل ہو چکی درخواست ہے — ایمرجنسی وارڈ نے پانادول اور بروفین مانگے تھے، اور یہ مکمل طور پر جاری ہو چکی ہے، کچھ باقی نہیں۔',
      async run(h) {
        await h.wait(500)
        await h.click(h.page.locator('tr[data-id]', { hasText: 'Emergency Ward' }))
      },
    },
    {
      en: 'Let’s close this and raise a brand-new request, to see the whole flow live.',
      ur: 'اب اسے بند کر کے ایک نئی درخواست بناتے ہیں، تاکہ پورا عمل خود دیکھ سکیں۔',
      async run(h) {
        await h.click(h.button('Close'))
        await h.click(h.button('New requisition'))
      },
    },
    {
      en: 'We pick Emergency Ward again, search for Brufen, add it, and set the quantity — then save the requisition.',
      ur: 'ہم دوبارہ ایمرجنسی وارڈ منتخب کرتے ہیں، بروفین تلاش کر کے شامل کرتے ہیں، مقدار درج کرتے ہیں — اور درخواست محفوظ کر لیتے ہیں۔',
      async run(h) {
        await h.select('#rqf select[name="department_id"]', { label: 'Emergency Ward' })
        await h.type('#rq-picker input', 'Brufen')
        await h.wait(400)
        await h.click(h.page.locator('#rq-picker .results button').first())
        await h.type('input[data-packs="0"]', '2')
        await h.click(h.button('Save requisition'))
      },
      gap: 600,
    },
    {
      en: 'Now, over on the Issue tab, we choose the department and pull in that fresh request — its items load in automatically.',
      ur: 'اب Issue ٹیب پر جا کر ہم شعبہ منتخب کرتے ہیں اور اسی نئی درخواست کو منتخب کرتے ہیں — اس کی اشیاء خود بخود شامل ہو جاتی ہیں۔',
      async run(h) {
        await h.click(h.button('Issue'))
        await h.wait(400)
        await h.select('#issf select[name="dept"]', { label: 'Emergency Ward' })
        await h.wait(700)
        await h.select('#issf select[name="request"]', { index: 1 })
        await h.wait(400)
      },
    },
    {
      en: 'We hit Issue stock to hand it over — it’s pulled from whichever batch expires soonest, and valued at cost.',
      ur: 'ہم Issue stock دباتے ہیں تاکہ مال فراہم ہو جائے — یہ اس بیچ سے لیا جاتا ہے جو پہلے ایکسپائر ہو رہا ہو، اور لاگت کے حساب سے شمار ہوتا ہے۔',
      async run(h) {
        await h.click(h.button('Issue stock'))
      },
      gap: 600,
    },
    {
      en: 'Every line keeps tracking what was requested versus what’s actually gone out, right up until it’s fully issued — and all of it stays separate from retail sales, valued strictly at cost. That’s departments and issues covered — check Help & tutorials any time you need a refresher.',
      ur: 'ہر لائن یہ ریکارڈ رکھتی ہے کہ کتنا مانگا گیا اور کتنا واقعی جاری ہوا، جب تک درخواست مکمل نہ ہو جائے — اور یہ سب کچھ ریٹیل فروخت سے الگ، صرف لاگت کے حساب سے رکھا جاتا ہے۔ یہ تھا Departments اور Issues کا جائزہ — جب بھی یاد دہانی چاہیے ہو، Help & tutorials دیکھ لیں۔',
    },
  ],
}
