/**
 * Markdown renderer tests (jsdom). The summary overview is rendered through this
 * tiny renderer, so it must turn `##` headers, `-` bullets, `**bold**`, and
 * blank-line paragraphs into real DOM — and NEVER inject raw HTML (XSS-safe).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown.js";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headers, bullets, bold, and paragraphs as DOM", () => {
    const src = [
      "## Pricing",
      "- Pricing moves to **usage-based** in Q3.",
      "- Expansion revenue is the goal.",
      "",
      "A closing thought.",
    ].join("\n");
    const { container } = render(<Markdown>{src}</Markdown>);

    // Header → a heading element with the section text.
    const heading = container.querySelector("h3");
    expect(heading?.textContent).toBe("Pricing");

    // Two bullets in a list.
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Pricing moves to usage-based in Q3.");

    // **bold** → <strong>.
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("usage-based");

    // Trailing paragraph.
    const paras = container.querySelectorAll("p");
    expect(paras[paras.length - 1]?.textContent).toBe("A closing thought.");
  });

  it("never injects raw HTML (renders it as text)", () => {
    const { container } = render(<Markdown>{"- <img src=x onerror=alert(1)> hi"}</Markdown>);
    // No <img> element is created — the angle-bracket text is escaped as text.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("markdown").textContent).toContain("<img src=x onerror=alert(1)> hi");
  });

  it("renders plain prose with no markdown as a single paragraph", () => {
    const { container } = render(<Markdown>{"Just a sentence."}</Markdown>);
    const paras = container.querySelectorAll("p");
    expect(paras).toHaveLength(1);
    expect(paras[0]?.textContent).toBe("Just a sentence.");
  });
});
