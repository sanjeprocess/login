/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK_API?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BROKER_NAME?: string;
  readonly VITE_SUPPORT_PHONE?: string;
  readonly VITE_SUPPORT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
