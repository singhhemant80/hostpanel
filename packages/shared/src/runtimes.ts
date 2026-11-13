export const RUNTIMES = ["php", "node", "python", "static"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Versions installable side by side. The installer sets up the defaults marked below. */
export const RUNTIME_VERSIONS: Record<Runtime, readonly string[]> = {
  php: ["7.4", "8.1", "8.2", "8.3", "8.4"],
  node: ["18", "20", "22", "24"],
  python: ["3.10", "3.11", "3.12", "3.13"],
  static: ["-"],
};

export const DEFAULT_VERSION: Record<Runtime, string> = {
  php: "8.3",
  node: "22",
  python: "3.12",
  static: "-",
};

/** Sensible defaults applied when a site is created and the user leaves fields empty. */
export const RUNTIME_DEFAULTS: Record<Runtime, { buildCmd: string; startCmd: string; publicDir: string }> = {
  php: { buildCmd: "if [ -f composer.json ]; then composer install --no-dev --optimize-autoloader; fi", startCmd: "", publicDir: "public" },
  node: { buildCmd: "npm ci && npm run build --if-present", startCmd: "npm start", publicDir: "" },
  python: {
    buildCmd: "python -m venv .venv && .venv/bin/pip install -r requirements.txt",
    startCmd: ".venv/bin/gunicorn -b 127.0.0.1:$PORT app:app",
    publicDir: "",
  },
  static: { buildCmd: "", startCmd: "", publicDir: "" },
};

/** Runtimes that run as a long-lived process behind a reverse proxy port. */
export function needsPort(runtime: Runtime): boolean {
  return runtime === "node" || runtime === "python";
}

/** Guess a runtime from the file names at a repo root (used when connecting GitHub). */
export function detectRuntime(files: string[]): Runtime {
  const has = (f: string) => files.includes(f);
  if (has("composer.json") || has("index.php") || has("artisan") || has("wp-config.php")) return "php";
  if (has("package.json")) {
    return "node";
  }
  if (has("requirements.txt") || has("pyproject.toml") || has("manage.py")) return "python";
  return "static";
}

export const PORT_RANGE = { min: 20000, max: 29999 } as const;
