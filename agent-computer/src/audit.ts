/**
 * Read-only accessibility probes, run inside the page on explicit QA request.
 *
 * `runPageAudit` and `describeActiveElement` are handed to `page.evaluate`, which serializes ONE
 * function and nothing around it: every helper they use lives INSIDE them, duplicated where both
 * need it. A module-level helper called from in here is a `ReferenceError` at runtime and a green
 * typecheck — the smoke test exists to catch exactly that.
 *
 * What these collect is authored page content — labels the site wrote, alt text it did not — never
 * field values, never URLs beyond a hostname, never text the visitor typed. That is why the audit
 * endpoints need no secret blackout: there is no secret in what they return. Anything that could
 * carry one (input values, full image URLs with query strings) is deliberately not collected.
 *
 * Bounded by construction: capped samples, capped element scans, no listeners, no retained state.
 */

const SAMPLE_LIMIT = 10;
const SCAN_LIMIT = 400;
const TEXT_LIMIT = 80;

export type ControlDescriptor = {
  tag: string;
  role: string;
  text: string;
};

export type ImageOffender = {
  index: number;
  host: string;
};

export type ContrastFailure = {
  descriptor: string;
  ratio: number;
};

export type PageAudit = {
  unnamedControls: { count: number; sample: ControlDescriptor[] };
  imagesMissingAlt: { count: number; sample: ImageOffender[] };
  contrastFailures: { count: number; sample: ContrastFailure[] };
};

/**
 * One audit pass over the live document.
 *
 * Runs in the page, so it sees `document` and nothing else: no closure over this module, no
 * imports, no network. Everything it returns is counted first and sampled second, so a page with
 * ten thousand images still answers with a small object.
 */
export function runPageAudit(): PageAudit {
  const trunc = (text: string): string =>
    text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;

  const hostOf = (src: string): string => {
    try {
      return new URL(src, "http://local").host || "relative";
    } catch {
      return "unparseable";
    }
  };

  /** The accessible-name approximation QA needs: empty means a screen reader gets nothing. */
  const approxName = (element: Element): string => {
    const labelled = element.getAttribute("aria-label")?.trim();
    if (labelled) return labelled;
    const labelledBy = element.getAttribute("aria-labelledby")?.trim();
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    }
    if (element instanceof HTMLInputElement) {
      if (element.labels?.[0]?.textContent?.trim())
        return element.labels[0].textContent.trim();
      if (element.type === "submit" || element.type === "button")
        return element.value.trim();
      if (element.type === "image") return element.alt.trim();
      return "";
    }
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
    return element.getAttribute("title")?.trim() ?? "";
  };

  const luminance = (color: string): number | null => {
    const match = color.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/,
    );
    if (!match?.[1] || !match[2] || !match[3]) return null;
    if (match[4] !== undefined && Number(match[4]) < 1) return null;
    const linear = [match[1], match[2], match[3]].map((part) => {
      const channel = Number(part) / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return (
      0.2126 * (linear[0] ?? 0) +
      0.7152 * (linear[1] ?? 0) +
      0.0722 * (linear[2] ?? 0)
    );
  };

  const contrastRatio = (
    foreground: string,
    background: string,
  ): number | null => {
    const light = luminance(foreground);
    const dark = luminance(background);
    if (light === null || dark === null) return null;
    const [high, low] = light >= dark ? [light, dark] : [dark, light];
    return (high + 0.05) / (low + 0.05);
  };
  const effectiveBackground = (element: Element): string | null => {
    let current: Element | null = element;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      const background = getComputedStyle(current).backgroundColor;
      const match = background.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
      if (!match || match[1] === "1") return background;
      current = current.parentElement;
    }
    // Transparent to the root: the page paints on the canvas, which defaults to white.
    return "rgb(255, 255, 255)";
  };

  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const unnamedSample: ControlDescriptor[] = [];
  let unnamedCount = 0;
  const controls = document.querySelectorAll(
    'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"]',
  );
  controls.forEach((element) => {
    if (element instanceof HTMLInputElement && element.type === "hidden")
      return;
    if (!approxName(element)) {
      unnamedCount += 1;
      if (unnamedSample.length < SAMPLE_LIMIT) {
        unnamedSample.push({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
          text: trunc((element.textContent ?? "").replace(/\s+/g, " ").trim()),
        });
      }
    }
  });

  const imageSample: ImageOffender[] = [];
  let imageCount = 0;
  document.querySelectorAll("img").forEach((image, index) => {
    if (!visible(image)) return;
    if (!image.hasAttribute("alt")) {
      imageCount += 1;
      if (imageSample.length < SAMPLE_LIMIT) {
        imageSample.push({
          index,
          host: hostOf(image.currentSrc || image.src),
        });
      }
    }
  });

  const contrastSample: ContrastFailure[] = [];
  let contrastCount = 0;
  let scanned = 0;
  const candidates = document.querySelectorAll(
    'button, a, h1, h2, h3, p, li, td, th, label, [role="button"], [role="link"]',
  );
  for (const element of candidates) {
    if (scanned >= SCAN_LIMIT) break;
    scanned += 1;
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const background = effectiveBackground(element);
    if (!background) continue;
    const ratio = contrastRatio(style.color, background);
    if (ratio !== null && ratio < 4.5) {
      contrastCount += 1;
      if (contrastSample.length < SAMPLE_LIMIT) {
        contrastSample.push({
          descriptor: trunc(
            `${element.tagName.toLowerCase()} "${approxName(element) || (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`,
          ),
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
  }

  return {
    unnamedControls: { count: unnamedCount, sample: unnamedSample },
    imagesMissingAlt: { count: imageCount, sample: imageSample },
    contrastFailures: { count: contrastCount, sample: contrastSample },
  };
}

/** Who holds focus right now, as role and label only — never a value. */
export function describeActiveElement(): ControlDescriptor | null {
  // Twin of the helpers above, inlined for the same serialization reason. Keep the two in sync.
  const trunc = (text: string): string =>
    text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
  const approxName = (element: Element): string => {
    const labelled = element.getAttribute("aria-label")?.trim();
    if (labelled) return labelled;
    if (element instanceof HTMLInputElement) {
      if (element.labels?.[0]?.textContent?.trim())
        return element.labels[0].textContent.trim();
      return "";
    }
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
    return element.getAttribute("title")?.trim() ?? "";
  };
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
    text: trunc(approxName(element)),
  };
}
