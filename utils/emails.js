// The emails MindSync sends (30/9): welcome + confirm the address, and the
// password reset link. Hebrew or English, by the language the person uses
// the app in (sent by the app at sign-up / on the reset page).
// Plain, table-free HTML: it has to look right in Gmail, Outlook and a
// phone, in both directions, and still read fine as the plain-text part.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(lang, bodyHtml) {
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const align = lang === 'he' ? 'right' : 'left';
  return `<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2433;">
<div dir="${dir}" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e6eb;border-radius:10px;padding:28px 26px;text-align:${align};line-height:1.6;font-size:15px;">
<div style="font-weight:bold;font-size:18px;margin-bottom:18px;"><span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:6px;background:#2f64d6;color:#fff;font-size:13px;margin-${lang === 'he' ? 'left' : 'right'}:8px;">M</span>MindSync</div>
${bodyHtml}
</div></body></html>`;
}

function button(href, label) {
  return `<p style="margin:24px 0;"><a href="${esc(href)}" style="display:inline-block;background:#2f64d6;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:bold;">${esc(label)}</a></p>`;
}

function small(text) {
  return `<p style="color:#6b7280;font-size:13px;margin:18px 0 0;">${text}</p>`;
}

// Welcome + confirm the address. The link works for 3 days.
function verifyEmail({ lang, name, link }) {
  const he = lang === 'he';
  const hi = name ? (he ? `היי ${esc(name)},` : `Hi ${esc(name)},`) : (he ? 'היי,' : 'Hi,');
  const subject = he ? 'ברוכים הבאים ל-MindSync - אישור כתובת המייל' : 'Welcome to MindSync - confirm your email';
  const html = layout(he ? 'he' : 'en', he ? `
<p>${hi}</p>
<p>ברוכים הבאים ל-MindSync! נשאר רק לאשר שכתובת המייל הזאת שלך. כך אפשר יהיה לאפס את הסיסמה אם היא תישכח.</p>
${button(link, 'אישור כתובת המייל')}
${small('הקישור תקף ל-3 ימים. אם לא נרשמת ל-MindSync, אפשר להתעלם מהמייל הזה.')}
${small(`אם הכפתור לא עובד, אפשר להעתיק את הקישור לדפדפן:<br><span dir="ltr" style="word-break:break-all;">${esc(link)}</span>`)}` : `
<p>${hi}</p>
<p>Welcome to MindSync! One last step: confirm that this email address is yours, so you can reset your password if you ever forget it.</p>
${button(link, 'Confirm my email')}
${small("The link works for 3 days. If you didn't sign up for MindSync, you can ignore this email.")}
${small(`If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(link)}</span>`)}`);
  const text = he
    ? `${name ? `היי ${name},` : 'היי,'}\n\nברוכים הבאים ל-MindSync! לאישור כתובת המייל:\n${link}\n\nהקישור תקף ל-3 ימים. אם לא נרשמת, אפשר להתעלם מהמייל.`
    : `${name ? `Hi ${name},` : 'Hi,'}\n\nWelcome to MindSync! Confirm your email here:\n${link}\n\nThe link works for 3 days. If you didn't sign up, ignore this email.`;
  return { subject, html, text };
}

// Password reset. The link works for 1 hour, once.
function resetEmail({ lang, link }) {
  const he = lang === 'he';
  const subject = he ? 'איפוס סיסמה ל-MindSync' : 'Reset your MindSync password';
  const html = layout(he ? 'he' : 'en', he ? `
<p>ביקשת לאפס את הסיסמה לחשבון MindSync שלך.</p>
${button(link, 'בחירת סיסמה חדשה')}
${small('הקישור תקף לשעה אחת ועובד פעם אחת. אחרי בחירת סיסמה חדשה, כל המכשירים האחרים יתנתקו.')}
${small('אם לא ביקשת את זה, אפשר להתעלם מהמייל - הסיסמה לא תשתנה.')}
${small(`אם הכפתור לא עובד, אפשר להעתיק את הקישור לדפדפן:<br><span dir="ltr" style="word-break:break-all;">${esc(link)}</span>`)}` : `
<p>You asked to reset the password for your MindSync account.</p>
${button(link, 'Choose a new password')}
${small('The link works for 1 hour, once. After you choose a new password, every other device is logged out.')}
${small("If you didn't ask for this, ignore this email - your password stays the same.")}
${small(`If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(link)}</span>`)}`);
  const text = he
    ? `ביקשת לאפס את הסיסמה ל-MindSync:\n${link}\n\nהקישור תקף לשעה ועובד פעם אחת. אם לא ביקשת, אפשר להתעלם.`
    : `You asked to reset your MindSync password:\n${link}\n\nThe link works for 1 hour, once. If you didn't ask for this, ignore this email.`;
  return { subject, html, text };
}

module.exports = { verifyEmail, resetEmail, esc };
