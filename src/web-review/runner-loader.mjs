export async function resolve(specifier, context, nextResolve) {
  const fromServer = context.parentURL?.endsWith("/server.js") || context.parentURL?.endsWith("\\server.js");
  if (fromServer && specifier === "./src/web-review/browser-runner.js") {
    return {
      url: new URL("./browser-runner-entry.js", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
