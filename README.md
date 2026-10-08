# MindSync Server

REST API for [MindSync](https://github.com/dorharel43/MindSync), an exam coach
for university students. Express 5 + MongoDB, with JWT authentication and
per-user data isolation.

The server is the single owner of all data. The desktop client holds no database
of its own and reaches everything through this API.

---

## Tech stack

Node.js · Express 5 · MongoDB (Mongoose 9) · JWT (`jsonwebtoken`) · bcrypt

Deployed on [Render](https://render.com).

---

## Getting started

### Prerequisites

- Node.js 18 or newer
- A MongoDB database — [MongoDB Atlas](https://www.mongodb.com/atlas) has a free tier

### Install

```bash
git clone https://github.com/dorharel43/MindSync-Server.git
cd MindSync-Server
npm install
cp .env.example .env     # then edit .env
npm run dev              # http://localhost:5000
```

The server refuses to start if a required variable is missing, and says which
one — a missing `JWT_SECRET` would otherwise sign every token with `undefined`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | **yes** | MongoDB connection string |
| `JWT_SECRET` | **yes** | Secret used to sign auth tokens. Use a long random string |
| `PORT` | no | Defaults to `5000`. Hosting platforms inject their own |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS allow-list. Unset means permissive, which is fine for local development only |

---

## API

All routes except `POST /api/auth/register` and `POST /api/auth/login` require an
`Authorization: Bearer <token>` header. Every query is scoped to the
authenticated user's `userId`.

| Prefix | Purpose |
|---|---|
| `/api/auth` | Register, log in, read and update the current user |
| `/api/tasks` | Tasks, including completion and bulk creation from extracted content |
| `/api/events` | Calendar events |
| `/api/folders` | Folders for study material |
| `/api/files` | Uploaded files and their extracted text |
| `/api/study` | Study items, recall questions, confidence calibration results |
| `/api/full-exams` | Full exams built like a course's past exams, their sittings and grading |
| `/api/exam-map` | What repeats in a course's past exams, joined with the student's answers |
| `/api/admin` | Hard reset of the caller's own data |

A health check is served at `/`.

## Tests

`npm test` runs every test in `tests/` against a real server and a fake Gemini
(`tests/fake-gemini.js`) - no AI key, nothing paid. It needs a MongoDB at
`TEST_MONGO` (default `mongodb://127.0.0.1:27017`); each run uses a fresh
database and drops it at the end. `npm test -- map daily` runs only the files
whose name has "map" or "daily". GitHub Actions runs the same on every pull
request (`.github/workflows/test.yml`).

- `tests/unit/` - pure checks (exam rules, math, JSON repair, the AI guard, and that every `t('...')` string has Hebrew).
- `tests/e2e/` - through the HTTP API: exam map, daily question, daily goal, per-criterion marks.

A new feature comes with its test here. A test passes only when it exits 0, prints no
`FAIL` line, and its final `N/M` count is complete - a test that checks nothing fails.


---

## Project structure

```
server.js            App bootstrap, env validation, CORS, route mounting
models/              Mongoose schemas — User, Task, Event, Folder, FileItem, Settings, StudyItem
routes/              One router per resource
middleware/
  auth.js            requireAuth — verifies the JWT and sets req.userId
  asyncHandler.js    Wraps async handlers so rejections reach the error handler
  ApiError.js        Error class carrying an HTTP status code
  errorHandler.js    Central error formatting and 404 handling
utils/
  scheduler.js       Recurring background work
  singleton.js       Helper for genuinely global documents
```

### Design decisions worth calling out

- **Fail fast on missing configuration.** The process exits at startup rather
  than failing later on a request that cannot be traced back to it.
- **`requireAuth` on every router, not per route.** A new route added to an
  existing router is protected by default. Forgetting is the common bug, so the
  safe state is the default one.
- **Every query is filtered by `userId`.** Nothing is global. An earlier version
  of the hard-reset endpoint called `deleteMany({})`, which would have wiped
  every user's data instead of the caller's.
- **Errors are centralised.** Routes throw `ApiError`; a single handler decides
  status codes and response shape, so no route invents its own format.

---

## Author

**Dor Harel** — Information Systems student, Yezreel Valley College
[github.com/dorharel43](https://github.com/dorharel43)

## License

[MIT](LICENSE)
