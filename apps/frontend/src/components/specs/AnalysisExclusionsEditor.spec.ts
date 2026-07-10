import type {
  ApiSpecMetadataDto,
  AppSpecsResponse,
  UpdateAnalysisExclusionsResponse,
} from "@mediator/contracts";
import type { Ir } from "@mediator/domain";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAppSpecs } from "../../api/apps";
import { updateAnalysisExclusions } from "../../api/specs";
import { testGlobalOptions } from "../../testing/render";
import AnalysisExclusionsEditor from "./AnalysisExclusionsEditor.vue";

vi.mock("../../api/apps", () => ({
  getAppSpecs: vi.fn(),
  listApps: vi.fn(),
  registerApp: vi.fn(),
}));
vi.mock("../../api/specs", () => ({
  updateAnalysisExclusions: vi.fn(),
  getSpecIr: vi.fn(),
  previewParse: vi.fn(),
}));

const getAppSpecsMock = vi.mocked(getAppSpecs);
const updateMock = vi.mocked(updateAnalysisExclusions);

const SPEC_ID = "spec-1";
const APP_ID = "app-1";

const ir: Ir = [
  { resourceRef: "issues", name: "issues", operations: [], schemas: [], crossResourceRefs: [] },
  { resourceRef: "labels", name: "labels", operations: [], schemas: [], crossResourceRefs: [] },
];

const spec: ApiSpecMetadataDto = {
  id: SPEC_ID,
  appId: APP_ID,
  role: "PROVIDER",
  version: 1,
  contentHash: "hash",
  status: "active",
  analysisExclusions: ["issues"],
  createdAt: "2026-07-10T00:00:00.000Z",
};

const specsResponse: AppSpecsResponse = { specs: [spec] };

const updated: UpdateAnalysisExclusionsResponse = {
  ...spec,
  analysisExclusions: ["issues", "labels"],
};

beforeEach(() => {
  vi.clearAllMocks();
  getAppSpecsMock.mockResolvedValue(specsResponse);
  updateMock.mockResolvedValue(updated);
});

describe("AnalysisExclusionsEditor (SI-4)", () => {
  it("seeds toggles from current exclusions and PATCHes the edited list", async () => {
    const wrapper = mount(AnalysisExclusionsEditor, {
      props: { specId: SPEC_ID, appId: APP_ID, ir },
      global: testGlobalOptions(),
    });
    await flushPromises();

    // Both resource groups are offered as toggles.
    expect(wrapper.find('[data-testid="exclusion-toggle-issues"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="exclusion-toggle-labels"]').exists()).toBe(true);

    // Add `labels` to the exclusion set and save.
    const labelsCheckbox = wrapper.get('[data-testid="exclusion-toggle-labels"]').get("input");
    await labelsCheckbox.setValue(true);
    await wrapper.get('[data-testid="exclusions-save"]').trigger("click");
    await flushPromises();

    expect(updateMock).toHaveBeenCalledWith(SPEC_ID, {
      analysisExclusions: ["issues", "labels"],
    });
  });
});
