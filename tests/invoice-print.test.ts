import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Navbar } from "../src/components/navbar";

describe("Invoice Print Layout & Styles", () => {
  it("verifies Navbar contains no-print and print:hidden classes", () => {
    const mockRouter: any = {
      back: () => {},
      forward: () => {},
      refresh: () => {},
      push: () => {},
      replace: () => {},
      prefetch: () => {},
    };

    const profile = {
      id: "u-test",
      role: "customer" as const,
      full_name: "Customer One",
      is_active: true,
      email: "cust@example.com",
    };

    const renderedHtml = renderToStaticMarkup(
      React.createElement(
        AppRouterContext.Provider,
        { value: mockRouter },
        React.createElement(
          PathnameContext.Provider,
          { value: "/dashboard" },
          React.createElement(Navbar, { profile })
        )
      )
    );

    assert.ok(
      renderedHtml.includes("no-print"),
      "Navbar header must include the 'no-print' class"
    );
    assert.ok(
      renderedHtml.includes("print:hidden"),
      "Navbar header must include the 'print:hidden' class"
    );
  });

  it("verifies invoice page source markup contains invoice-print-root and no-print classes", () => {
    const invoicePagePath = path.resolve(
      process.cwd(),
      "src/app/(app)/requests/[id]/invoice/page.tsx"
    );
    const content = fs.readFileSync(invoicePagePath, "utf8");

    // Check that invoice-print-root class is present on the printable card
    assert.ok(
      content.includes("invoice-print-root"),
      "Invoice card must contain 'invoice-print-root' class"
    );

    // Check that the top action bar buttons container has no-print
    assert.ok(
      content.includes("no-print"),
      "Action buttons must be wrapped in 'no-print' class"
    );

    // Check that print stylesheet scopes rules to invoice-print-root and no-print
    assert.ok(
      content.includes(".invoice-print-root"),
      "Print stylesheet must define styles for .invoice-print-root"
    );
    assert.ok(
      content.includes(".no-print"),
      "Print stylesheet must hide .no-print elements"
    );

    // Check that page fit enforces A4 portrait
    assert.ok(
      content.includes("size: A4 portrait;"),
      "Print stylesheet must set @page size to A4 portrait"
    );

    // Check that break-inside: avoid is set on invoice-print-root for single page fit
    assert.ok(
      content.includes("break-inside: avoid;"),
      "Print stylesheet must prevent page breaking inside invoice-print-root"
    );
  });

  it("verifies globals.css does NOT contain body * visibility hidden rule", () => {
    const globalsCssPath = path.resolve(process.cwd(), "src/app/globals.css");
    const content = fs.readFileSync(globalsCssPath, "utf8");

    assert.ok(
      !content.includes("visibility: hidden"),
      "globals.css must not use visibility: hidden on body * or any print rule"
    );

    assert.ok(
      content.includes(".invoice-print-root"),
      "globals.css must define print styles for .invoice-print-root"
    );

    assert.ok(
      content.includes(".no-print"),
      "globals.css must hide .no-print in @media print"
    );
  });
});
