export default {
  id: '02-making-a-sale',
  title: { en: 'Making a sale', ur: 'فروخت کیسے کریں' },
  scenes: [
    {
      en: "Let's make a sale from start to finish — opening your till, ringing up medicines, handling a prescription item, taking payment, and even processing a return.",
      ur: 'آئیے شروع سے آخر تک ایک سیل کرتے ہیں — till کھولنا، دوائیں بِل میں شامل کرنا، ایک نسخہ والی دوا کو سنبھالنا، ادائیگی وصول کرنا، اور آخر میں ایک ریٹرن بھی پروسیس کرنا۔',
    },
    {
      en: 'First, open your till for the shift. Tap Open till, count your starting cash by denomination, and confirm.',
      ur: 'پہلے اپنی شفٹ کے لیے till کھولیں۔ Open till پر ٹیپ کریں، اپنی ابتدائی نقدی نوٹوں کے حساب سے گنیں، اور تصدیق کر دیں۔',
      async run(h) {
        await h.click(h.nav('till'))
        await h.click('#open')
        await h.type(h.label('Count of Rs 1000'), '10')
        await h.click('#otf button.primary')
      },
    },
    {
      en: "With the till open, head to Point of sale — that's where every sale starts.",
      ur: 'till کھلنے کے بعد Point of sale پر جائیں — یہیں سے ہر سیل شروع ہوتی ہے۔',
      async run(h) {
        await h.click(h.nav('pos'))
      },
    },
    {
      en: "Search or scan the medicine — type 'Panadol', pick it from the list, and bump the quantity up to two packs.",
      ur: "دوا تلاش کریں یا اسکین کریں — 'Panadol' لکھیں، فہرست سے منتخب کریں، اور مقدار بڑھا کر دو پیکٹ کر دیں۔",
      async run(h) {
        await h.type('#q', 'Panadol')
        await h.click('#results button')
        await h.type('input[data-packs="0"]', '2')
        await h.page.locator('input[data-packs="0"]').press('Enter')
      },
    },
    {
      en: 'Add a second item the same way — search for Brufen and select it.',
      ur: 'دوسری دوا بھی اسی طرح شامل کریں — Brufen تلاش کریں اور اسے منتخب کریں۔',
      async run(h) {
        await h.type('#q', 'Brufen')
        await h.click('#results button')
      },
    },
    {
      en: "Now add Augmentin, a prescription medicine — a panel pops up asking for the patient and doctor's name. A controlled drug like Tramal would also need the patient's CNIC and the doctor's PMDC number. We'll take it back out for this sale.",
      ur: 'اب Augmentin شامل کریں، جو ایک نسخے والی دوا ہے — ایک پینل کھلتا ہے جو مریض اور ڈاکٹر کا نام مانگتا ہے۔ Tramal جیسی کنٹرولڈ دوا کے لیے مریض کا CNIC اور ڈاکٹر کا PMDC نمبر بھی درکار ہوتا ہے۔ ابھی کے لیے ہم اسے بل سے ہٹا دیتے ہیں۔',
      async run(h) {
        await h.type('#q', 'Augmentin')
        await h.click('#results button')
        await h.mark('#rx', 2200)
        await h.click('[data-rm="2"]')
      },
    },
    {
      en: 'Cash is already selected as the payment method — tap Complete sale to finish the transaction.',
      ur: 'ادائیگی کا طریقہ پہلے سے Cash منتخب ہے — لین دین مکمل کرنے کے لیے Complete sale پر ٹیپ کریں۔',
      async run(h) {
        await h.pointAt(h.button('Cash', { exact: true }))
        await h.click('#checkout')
      },
    },
    {
      en: "And that's it — invoice generated, change calculated, and a receipt ready to print. Tap New sale to start the next customer.",
      ur: 'اور بس — انوائس تیار، باقی رقم کا حساب لگ گیا، اور رسید پرنٹ کے لیے تیار ہے۔ نئے کسٹمر کے لیے New sale پر ٹیپ کریں۔',
      async run(h) {
        await h.mark('.receipt', 1600)
        await h.click(h.button('New sale'))
      },
    },
    {
      en: 'Over on Sales & returns, click any invoice to see its details, enter how many units are coming back, add a reason, and process the return.',
      ur: 'Sales & returns میں جا کر کسی بھی انوائس پر کلک کریں، واپس آنے والی مقدار درج کریں، وجہ لکھیں، اور ریٹرن پروسیس کر دیں۔',
      async run(h) {
        await h.click(h.nav('sales'))
        await h.click('#list tr[data-id]')
        await h.type(h.label('Return quantity (units)'), '1')
        await h.type(h.label('Return reason'), 'Customer changed their mind')
        await h.click(h.button('Process return', { exact: true }))
      },
    },
    {
      en: "At the end of your shift, come back to Till and tap Close till — count the drawer again, and the system tells you if you're short or over.",
      ur: 'شفٹ کے اختتام پر دوبارہ Till پر آئیں اور Close till پر ٹیپ کریں — دراز دوبارہ گنیں، اور سسٹم بتا دے گا کہ رقم کم ہے یا زیادہ۔',
      async run(h) {
        await h.click(h.nav('till'))
        await h.mark('#close', 1800)
      },
    },
  ],
}
