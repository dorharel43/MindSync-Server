# העלאת גרסת הווב של MindSync – מה צריך לעשות

המסמך הזה מסביר מה **אתה** צריך לעשות כדי שגרסת הווב תעלה לאוויר. הקוד כבר מוכן בענף `web-version`. מה שנשאר זה הגדרות בחשבונות שלך (Render, Google Cloud, דומיין), ואת זה רק אתה יכול לעשות.

סדר מומלץ: **1 → 2 → 3 → 4**. אחרי שלב 2 האפליקציה כבר עובדת בדפדפן. שלבים 3–4 מוסיפים את Google Calendar.

---

## 0. מה השתנה (בקצרה)

| כתובת | מה יש שם |
|---|---|
| `/` | דף בית ציבורי: מה זה MindSync, כפתור לאפליקציה, קישור למדיניות פרטיות |
| `/app/` | האפליקציה עצמה, בדיוק אותו ממשק כמו בדסקטופ |
| `/privacy` | מדיניות פרטיות (גוגל דורשת אותה) |
| `/api/...` | ה-API הקיים, ועוד: `rpc`, `uploads`, `feedback`, `google` |

- **AI:** רץ על השרת עם **המפתח שלך**. לכל משתמש יש מכסה יומית, כדי שמשתמש אחד לא ירוקן לך את התקציב.
- **קבצים:** נשמרים במסד הנתונים (GridFS ב-MongoDB), כי הדיסק של Render נמחק בכל הפעלה מחדש.
- **Google Calendar:** כל משתמש מחבר את החשבון שלו פעם אחת. האירועים נכנסים ללוח שנה נפרד בשם "MindSync" בחשבון שלו.
- **אפליקציית הדסקטופ ממשיכה לעבוד כרגיל.** כל השינויים בה מוסתרים בדסקטופ (`web-only`), חוץ משני תיקוני באגים שמשפרים גם אותה.

---

## 1. לפני המיזוג: בדיקה מהירה אצלך (לא חובה, מומלץ)

```bash
cd MindSync-Server
git fetch && git checkout web-version
npm install
# ב-.env שלך: MONGO_URI, JWT_SECRET, ועכשיו גם GEMINI_API_KEY
npm start
```
פתח `http://localhost:5000/` בדפדפן, לחץ **Open MindSync**, הירשם, העלה קובץ, בקש סיכום.

> **הערה:** הקבצים בתיקייה `web/` **נוצרים אוטומטית** מהריפו של הדסקטופ. לא עורכים אותם ידנית. כשמשנים משהו בממשק (`renderer.js`, `index.html` וכו' בריפו `MindSync`), מריצים:
> ```bash
> python3 tools/sync-web.py ../MindSync
> ```
> ומבצעים commit לתיקייה `web/` בריפו של השרת. בלי זה, גרסת הווב לא תקבל את השינוי.

---

## 2. Render: משתני סביבה (Environment)

ב-Render: השירות של השרת → **Environment** → **Add Environment Variable**.

### חובה
| משתנה | ערך | הסבר |
|---|---|---|
| `MONGO_URI` | (כבר קיים) | |
| `JWT_SECRET` | (כבר קיים) | |
| `GEMINI_API_KEY` | המפתח מ-[aistudio.google.com/apikey](https://aistudio.google.com/apikey) | בלי זה אין AI בגרסת הווב |

### מומלץ לבטא
| משתנה | ברירת מחדל | הסבר |
|---|---|---|
| `AI_DAILY_HEAVY` | `15` | כמה פעולות "כבדות" (סיכום / שאלות / קריאת סילבוס) משתמש יכול לעשות ביום |
| `AI_DAILY_LIGHT` | `150` | פעולות קלות (סיווג משימה, קריאת תאריך) |
| `UPLOAD_MAX_MB` | `20` | גודל מקסימלי לקובץ אחד |
| `UPLOAD_USER_CAP_MB` | `300` | נפח מקסימלי למשתמש. **בבטא כדאי לשים `30`** (ראה "אחסון" למטה) |
| `CONTACT_EMAIL` | (ריק) | כתובת מייל שתופיע במדיניות הפרטיות. אם ריק, כתוב שם "דרך Send feedback באפליקציה" |
| `GEMINI_MODEL` | `gemini-3.8-flash` | אין סיבה לשנות |

### ל-Google Calendar (אחרי שלב 3)
| משתנה | ערך |
|---|---|
| `GOOGLE_CLIENT_ID` | מ-Google Cloud (שלב 3) |
| `GOOGLE_CLIENT_SECRET` | מ-Google Cloud (שלב 3) |
| `GOOGLE_REDIRECT_URI` | `https://<הכתובת-של-השרת>/api/google/callback` – **בדיוק** כמו שרשמת ב-Google Cloud |
| `GOOGLE_TOKEN_KEY` | מחרוזת אקראית ארוכה. מייצרים כך: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

> ⚠️ **לא לשנות את `GOOGLE_TOKEN_KEY` אחרי שמשתמשים התחברו.** איתו מוצפנים הטוקנים של גוגל. אם מחליפים אותו, כל המשתמשים יצטרכו להתחבר לגוגל מחדש.
> אם לא מגדירים אותו בכלל, הקוד משתמש במפתח שנגזר מ-`JWT_SECRET`. זה עובד, אבל עדיף מפתח נפרד.

### שלוש הערות חשובות על עלויות ומגבלות

1. **Gemini – חייבים להפעיל billing לפני שמפרסמים.** במפתח חינמי יש כ-20 בקשות **ביום לכל המפתח**, ובווב המפתח משותף לכל המשתמשים. כלומר 2–3 סטודנטים ירוקנו אותו בבוקר. בנוסף, בשכבה החינמית גוגל רשאית להשתמש בתוכן שנשלח כדי לשפר את המוצרים שלה, ובשכבה בתשלום לא. את זה אתה לא רוצה עם קבצים של משתמשים.
   → ב-AI Studio: **Set up billing** על הפרויקט של המפתח, ומיד אחר כך **Budget alert** ב-Google Cloud Billing (למשל התראה ב-10$).
2. **Render בחינם "נרדם"** אחרי 15 דקות בלי שימוש. הכניסה הבאה לוקחת בערך דקה. לבדיקה עצמית זה בסדר. לפני פרסום בקבוצות פייסבוק כדאי לעבור לתוכנית Starter, אחרת הרושם הראשון של אנשים יהיה "זה לא עובד".
3. **אחסון:** ב-MongoDB Atlas החינמי יש 512MB **לכל המסד**, כולל הקבצים שמעלים. לכן בבטא עדיף `UPLOAD_USER_CAP_MB=30`. כשיהיו יותר משתמשים, השדרוג הטבעי הוא להעביר את הקבצים ל-Cloudflare R2 (בערך 10GB בחינם). זה שינוי בקובץ אחד (`rpc/storage.js`).

---

## 3. Google Cloud: יצירת חיבור ל-Google Calendar

נכנסים ל-[console.cloud.google.com](https://console.cloud.google.com). אפשר להשתמש בפרויקט הקיים של הדסקטופ או ליצור חדש בשם `MindSync`.

1. **הפעלת ה-API:** APIs & Services → **Library** → מחפשים **Google Calendar API** → **Enable**.
2. **מסך ההסכמה** (Google Auth Platform / OAuth consent screen):
   - **Branding:** App name `MindSync`, User support email = המייל שלך, App logo (לא חובה).
     - Application home page: `https://<הדומיין>/`
     - Privacy policy: `https://<הדומיין>/privacy`
     - Authorized domains: `<הדומיין>` (בלי https)
   - **Audience:** User type = **External**. בינתיים נשאר ב-**Testing**. תחת **Test users** מוסיפים את המיילים של מי שבודק (עד 100).
   - **Data access** → Add or remove scopes → מוסיפים:
     - `.../auth/calendar.app.created`
     - `openid`
     - `.../auth/userinfo.email`
3. **יצירת Client:** Clients (או Credentials) → **Create client** → Application type: **Web application**
   - Name: `MindSync Web`
   - **Authorized redirect URIs:** `https://<הכתובת-של-השרת>/api/google/callback`
     (אפשר להוסיף גם `http://localhost:5000/api/google/callback` לבדיקה מקומית)
   - שומרים, ומעתיקים את **Client ID** ו-**Client secret** ל-Render (שלב 2).

> זה **client נפרד** מזה של הדסקטופ (ה-`credentials.json` מסוג Desktop app). את הישן לא נוגעים.

### מה המשמעות של מצב Testing
- רק משתמשים שהוספת ל-**Test users** יכולים לחבר את היומן. אחרים יקבלו מגוגל "Access blocked".
- גוגל מבטלת את החיבור **כל 7 ימים**. האפליקציה מזהה את זה ומציגה "MindSync lost access to your Google Calendar – reconnect it in Settings", והמשתמש לוחץ Connect שוב.
- לבטא קטנה של חברים זה מספיק. לפרסום פתוח בפייסבוק צריך את שלב 4.

---

## 4. דומיין ואימות של גוגל (לפני פרסום פתוח)

כדי שכל אחד יוכל לחבר את היומן, צריך ללחוץ **Publish app** ולעבור אימות (verification) של גוגל. בשביל זה צריך:

1. **דומיין משלך** (בערך 10$ לשנה, למשל ב-Cloudflare Registrar או Namecheap). כתובת `onrender.com` לא מספיקה, כי גוגל דורשת להוכיח בעלות על הדומיין, ועל `onrender.com` אי אפשר.
   - ב-Render: Settings → **Custom Domains** → מוסיפים את הדומיין ועושים את רשומות ה-DNS לפי ההוראות שלהם.
   - אחרי שזה עובד, מעדכנים את `GOOGLE_REDIRECT_URI` ב-Render **וגם** ב-Google Cloud לכתובת עם הדומיין החדש.
2. **אימות בעלות** על הדומיין ב-[Google Search Console](https://search.google.com/search-console) (רשומת TXT ב-DNS), עם אותו חשבון גוגל של הפרויקט.
3. **Publish app** במסך Audience ← **Prepare for verification**. גוגל תבקש:
   - **הסבר למה צריך את ההרשאה.** אפשר להדביק:
     > MindSync is a study planner for students. When a user chooses to connect Google Calendar, MindSync creates a dedicated secondary calendar named "MindSync" and adds, updates and removes only the study events the user syncs from the app (classes, exams, study blocks). We use calendar.app.created because it is the narrowest scope for this: MindSync cannot read or change the user's other calendars.
   - **סרטון הדגמה** (אפשר unlisted ביוטיוב, 1–2 דקות): הכתובת בשורת הדפדפן נראית → Settings → Connect → מסך ההסכמה של גוגל, **כשהשפה באנגלית ושם ההרשאה נראה** → חזרה לאפליקציה "Connected" → הוספת מבחן עם "Also add to Google Calendar" → האירוע מופיע ב-Google Calendar בלוח "MindSync".
   - דף בית ומדיניות פרטיות על הדומיין המאומת. הם כבר קיימים ב-`/` וב-`/privacy`.
4. זמן האימות: לרוב כמה ימי עבודה, לפעמים יותר אם גוגל שואלת שאלות. **כדאי להתחיל את זה מוקדם.**

> ❓ לא בדקתי ב-100% אם גוגל מסווגת את `calendar.app.created` כ-sensitive (שדורש את התהליך למעלה) או כמשהו קל יותר. בפועל, אם במסך Data access ההרשאה מופיעה תחת "Your sensitive scopes", צריך את התהליך המלא.

---

## 5. מה נבדק (כדי שתדע על מה אפשר לסמוך)

נבדק כאן על מסד MongoDB תואם, עם "Gemini מזויף" ו"גוגל מזויף", כשהשרת רץ ב-UTC כמו ב-Render:

- **API של השרת:** 48/48. כולל הרשמה, בידוד בין משתמשים (משתמש אחד לא רואה ולא יכול להשתמש בקבצים של אחר), העלאת PDF וקריאה שלו ע"י ה-AI, מכסה יומית, מחיקת קובץ שמוחקת גם את המקור, וזרימת Google המלאה: חיבור, state מזויף שנדחה, ביטול אצל גוגל, אירוע שבועי/חד-פעמי בשעון ישראל, מחיקה, לוח שנה שנמחק אצל גוגל ונוצר מחדש, וניתוק.
- **יחידה של Google:** 10/10. הצפנה, חישוב "היום" בישראל ליד חצות, ומה קורה כשגוגל מבטלת גישה.
- **בדפדפן אמיתי (Chromium):** 25/25. דף בית → הרשמה → הגדרות → חיבור/ניתוק גוגל → העלאת 2 קבצים (כולל שם עם `"`) → סיכום בלשונית חדשה עם נוסחאות → שאלות מה-PDF → הוספת מבחן עם סימון גוגל (מתחבר במקום) → לשונית שנייה → התנתקות בשתי הלשוניות. **אפס שגיאות JavaScript.**

**מה לא נבדק:** Google ו-Gemini **האמיתיים**. את זה תראה רק אחרי שלבים 2–3. אם משהו לא עובד שם, הלוגים ב-Render (Logs) יראו שורה שמתחילה ב-`❌ Google` או `❌ rpc` עם הסיבה.

---

## 6. מגבלות ידועות (לא חוסמות בטא)

- **עדכונים ברקע:** כשה-AI מסיים משהו ברקע (למשל סיווג דחיפות של משימה), הרשימה מתעדכנת רק בכניסה הבאה למסך או ברענון, ולא מיד כמו בדסקטופ.
- **אירועים שסונכרנו מהדסקטופ** נמצאים בלוח הראשי שלך בגוגל, ולא בלוח "MindSync". מחיקה שלהם מגרסת הווב לא תמחק אותם מגוגל.
- **מחיקת חשבון מלאה** אין עדיין כפתור. לפי מדיניות הפרטיות, עושים את זה ידנית לפי בקשה במייל.
- **מצב פוקוס** (חסימת אפליקציות) קיים רק בדסקטופ. בדפדפן אי אפשר לסגור תוכנות אחרות.
