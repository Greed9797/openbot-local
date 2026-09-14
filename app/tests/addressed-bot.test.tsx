import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun runs test files in one process: a second unconditional register throws.
if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/*
 * Deliberately dynamic: a static import is hoisted above the `register` call, and these modules
 * read the DOM while they evaluate — `render` binds `document.body`, and the app's `client` reads
 * `window.location` for its base URL. Hoisted, they would run before a DOM exists.
 */
const { render, waitFor } = await import("@testing-library/react");
const { ActiveBotProvider, useActiveBot } = await import(
  "../src/lib/copilot/active-bot"
);
/*
 * The real app component, not a local stand-in: it is what mounts the grants query app-wide, and a
 * call site that goes back to the placeholder id is exactly the regression this guards. With no
 * published components it renders no children, so it needs no SDK context.
 */
const { SandboxedTools } = await import("../src/lib/copilot/sandboxed-tools");

/** A channel surface: it declares the Bot it drives for as long as it is mounted. */
function Channel({ botId }: { botId: string }) {
  useActiveBot(botId);
  return <SandboxedTools />;
}

let asked: string[] = [];
let realFetch: typeof fetch;
const views: { unmount: () => void }[] = [];

beforeEach(() => {
  asked = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    asked.push(String(input));
    return new Response("[]", {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
});

afterEach(() => {
  // Unmounted before the next case: a live tree keeps polling on its own interval, and its requests
  // would land in the next case's tally. The stub is handed back because Bun shares one process.
  for (const view of views.splice(0)) view.unmount();
  globalThis.fetch = realFetch;
  asked = [];
});

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ActiveBotProvider>{children}</ActiveBotProvider>
    </QueryClientProvider>,
  );
  views.push(view);
  return view;
}

function grantRequests(): string[] {
  return asked.filter((url) => url.includes("/api/components/for-agent/"));
}

describe("component grants follow the Bot actually being driven", () => {
  test("a surface driving no Bot asks nothing", async () => {
    mount(<SandboxedTools />);

    // Long enough for an enabled query to have reached the stub.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(grantRequests()).toEqual([]);
  });

  test("a channel asks for the Bot it drives", async () => {
    mount(<Channel botId="risk-analyst" />);

    await waitFor(() => {
      expect(grantRequests()).toHaveLength(1);
    });
    expect(grantRequests()[0]).toContain(
      "/api/components/for-agent/risk-analyst",
    );
  });
});
