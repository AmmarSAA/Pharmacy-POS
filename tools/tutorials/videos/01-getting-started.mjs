export default {
  id: '01-getting-started',
  title: { en: 'Getting started', ur: 'شروعات کیسے کریں' },
  scenes: [
    {
      en: "Welcome to City Care Pharmacy's point-of-sale system! In this quick tour we'll walk through the dashboard and every section of the menu, so you know exactly where everything lives.",
      ur: 'سٹی کیئر فارمیسی کے پوائنٹ آف سیل سسٹم میں خوش آمدید! اس مختصر ٹور میں ہم ڈیش بورڈ اور مینیو کے ہر حصے پر ایک نظر ڈالیں گے، تاکہ آپ کو معلوم ہو کہ ہر چیز کہاں موجود ہے۔',
    },
    {
      en: "Your dashboard opens right here — today's sales, stock value, supplier dues and more, plus a quick look at your till.",
      ur: 'آپ کا ڈیش بورڈ یہیں کھلتا ہے — آج کی سیل، اسٹاک کی مالیت، سپلائرز کے واجبات، اور آپ کے till کی ایک جھلک۔',
      async run(h) {
        await h.mark('.dash-cards', 1400)
        await h.mark(h.text('My till'), 1400)
      },
    },
    {
      en: 'On the left, Point of sale is where every sale happens, and Till is where you open and close your cash drawer each shift.',
      ur: 'بائیں جانب، Point of sale وہ جگہ ہے جہاں ہر سیل ہوتی ہے، اور Till میں آپ ہر شفٹ میں اپنا کیش دراز کھولتے اور بند کرتے ہیں۔',
      async run(h) {
        await h.pointAt(h.nav('pos'))
        await h.pointAt(h.nav('till'))
      },
    },
    {
      en: "Sales & returns keeps a record of every invoice, Products is your full medicine catalogue, and Stock & expiry tracks batches and what's expiring soon.",
      ur: 'Sales & returns میں ہر رسید کا ریکارڈ موجود ہے، Products آپ کی مکمل دواؤں کی فہرست ہے، اور Stock & expiry بیچز اور قریب الختم اسٹاک پر نظر رکھتا ہے۔',
      async run(h) {
        await h.pointAt(h.nav('sales'))
        await h.pointAt(h.nav('products'))
        await h.pointAt(h.nav('stock'))
      },
    },
    {
      en: 'When stock arrives, you receive it under Purchases, raise orders ahead of time with Purchase orders, and manage your vendors under Suppliers.',
      ur: 'جب اسٹاک آتا ہے تو آپ اسے Purchases کے تحت وصول کرتے ہیں، وقت سے پہلے آرڈر Purchase orders سے دیتے ہیں، اور اپنے سپلائرز کو Suppliers میں منظم کرتے ہیں۔',
      async run(h) {
        await h.pointAt(h.nav('purchases'))
        await h.pointAt(h.nav('purchase-orders'))
        await h.pointAt(h.nav('suppliers'))
      },
    },
    {
      en: 'Customers holds accounts and loyalty points, Transfers moves stock between locations, and Reports and Analytics show you how the business is really doing.',
      ur: 'Customers میں اکاؤنٹس اور لائلٹی پوائنٹس محفوظ ہیں، Transfers اسٹاک کو ایک جگہ سے دوسری جگہ منتقل کرتا ہے، اور Reports اور Analytics آپ کو کاروبار کی حقیقی صورتحال دکھاتے ہیں۔',
      async run(h) {
        await h.pointAt(h.nav('customers'))
        await h.pointAt(h.nav('transfers'))
        await h.pointAt(h.nav('reports'))
        await h.pointAt(h.nav('analytics'))
      },
    },
    {
      en: 'Issues sends stock out to hospital wards, Employees and Appointments manage your team and their schedules, and Messages and Knowledge keep everyone informed.',
      ur: 'Issues اسپتال کے وارڈز کو اسٹاک جاری کرتا ہے، Employees اور Appointments آپ کی ٹیم اور ان کے شیڈول کو سنبھالتے ہیں، اور Messages اور Knowledge سب کو باخبر رکھتے ہیں۔',
      async run(h) {
        await h.pointAt(h.nav('issues'))
        await h.pointAt(h.nav('employees'))
        await h.pointAt(h.nav('appointments'))
        await h.pointAt(h.nav('messages'))
        await h.pointAt(h.nav('knowledge'))
      },
    },
    {
      en: 'Under Users and Roles you add staff and control what they can do, and Settings holds your pharmacy\'s details and preferences.',
      ur: 'Users اور Roles کے تحت آپ عملہ شامل کرتے ہیں اور ان کے اختیارات طے کرتے ہیں، جبکہ Settings میں آپ کی فارمیسی کی تفصیلات اور ترجیحات موجود ہیں۔',
      async run(h) {
        await h.pointAt(h.nav('users'))
        await h.pointAt(h.nav('roles'))
        await h.pointAt(h.nav('settings'))
      },
    },
    {
      en: 'Right at the bottom of the menu is Help & tutorials, and this assistant button sits in the corner too.',
      ur: 'مینیو کے سب سے نیچے Help & tutorials موجود ہے، اور یہ اسسٹنٹ بٹن بھی کونے میں موجود ہے۔',
      async run(h) {
        await h.pointAt(h.nav('help'))
        await h.mark('.as-fab', 1800)
      },
    },
    {
      en: "Every topic in this tour has its own short video under Help & tutorials, and you can always ask the assistant a 'how do I...' question — it'll point you straight to the right one. Enjoy running your pharmacy!",
      ur: "اس ٹور کے ہر موضوع کی اپنی مختصر ویڈیو Help & tutorials میں موجود ہے، اور آپ اسسٹنٹ سے کوئی بھی 'میں یہ کیسے کروں' سوال پوچھ سکتے ہیں — وہ آپ کو سیدھا درست ویڈیو تک پہنچا دے گا۔ اپنی فارمیسی چلانے میں کامیابی ہو!",
    },
  ],
}
