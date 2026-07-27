/** The only renderer origins this process ever serves. */
export const rendererMayNavigate = (raw: string, development: boolean): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === "file:") return true;
  return development && url.origin === "http://localhost:5173";
};

/** Links leave through the system browser, and only as web links. */
export const mayOpenExternally = (raw: string): boolean => {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};
