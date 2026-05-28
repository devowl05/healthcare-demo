/// <reference types="vite/client" />

// Project-specific env vars. Augment Vite's ImportMetaEnv so `import.meta.env`
// is typed.
interface ImportMetaEnv {
  readonly VITE_LANGFUSE_PUBLIC_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
