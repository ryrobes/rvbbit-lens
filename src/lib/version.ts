import pkg from "../../package.json"

/** App version, sourced from package.json at build time. */
export const APP_VERSION: string = pkg.version

/** Product name shown in the menu bar / About dialog. */
export const APP_NAME = "rvbbit-lens"
