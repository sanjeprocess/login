# Motor Insurance Gateway

This workspace contains the frontend and backend as separate applications:

- `frontend/` — React webform, served by Vite on port 5173.
- `backend/` — Express API, served on port 4000.

## Run locally

Open two terminals:

```powershell
cd frontend
npm run dev
```

```powershell
cd backend
npm run dev
```

The frontend proxies `/api` requests to `http://localhost:4000`. Backend WorkHub24 credentials and settings belong in `backend/.env.local`, not in frontend environment variables.
