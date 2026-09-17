# MindSync Server

REST API for [MindSync](https://github.com/dorharel43/MindSync), an AI study
assistant for students. Express 5 + MongoDB, with JWT authentication and
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
| `/api/settings` | Per-user settings |
| `/api/study` | Study items, recall questions, confidence calibration results |
| `/api/admin` | Hard reset of the caller's own data |

A health check is served at `/`.

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
