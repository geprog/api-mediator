import type { Ir } from "@mediator/domain";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../testing/render";
import IrViewer from "./IrViewer.vue";

const ir: Ir = [
  {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "issueListIssues",
        method: "get",
        path: "/repos/{owner}/{repo}/issues",
        summary: "List a repository's issues",
        parameters: [{ name: "page", location: "query", required: false, type: "integer" }],
        responseSchema: {
          name: "Issue",
          fields: [{ name: "id", type: "integer", required: true }],
        },
      },
    ],
    schemas: [
      {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true, description: "The issue title" },
        ],
      },
    ],
    crossResourceRefs: [{ name: "User", fields: ["id", "login"] }],
  },
];

describe("IrViewer (SI-3)", () => {
  it("renders resource groups and drills into operations and schema fields", () => {
    const wrapper = mount(IrViewer, { props: { ir }, global: testGlobalOptions() });

    // Resource group is addressable by its stable resourceRef.
    expect(wrapper.find('[data-testid="ir-group-issues"]').exists()).toBe(true);

    // The operation's method/path/summary/operationId are shown.
    const operation = wrapper.get('[data-testid="ir-operation-issueListIssues"]');
    const operationText = operation.text();
    expect(operationText).toContain("GET");
    expect(operationText).toContain("/repos/{owner}/{repo}/issues");
    expect(operationText).toContain("List a repository's issues");
    expect(operationText).toContain("page");

    // Flattened schema fields carry name / type / required-ness / description.
    expect(wrapper.find('[data-testid="ir-field-id"]').exists()).toBe(true);
    const titleField = wrapper.get('[data-testid="ir-field-title"]');
    expect(titleField.text()).toContain("title");
    expect(titleField.text()).toContain("string");
    expect(titleField.text()).toContain("The issue title");

    // Cross-resource references are summarized, not expanded.
    expect(wrapper.text()).toContain("User");
    expect(wrapper.text()).toContain("login");
  });

  it("shows an empty state for a spec with no resource groups", () => {
    const wrapper = mount(IrViewer, { props: { ir: [] }, global: testGlobalOptions() });
    expect(wrapper.find('[data-testid="ir-empty"]').exists()).toBe(true);
  });
});
