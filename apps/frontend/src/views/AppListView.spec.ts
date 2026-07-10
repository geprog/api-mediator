import type { AppListResponse } from "@mediator/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listApps } from "../api/apps";
import { testGlobalOptions } from "../testing/render";
import AppListView from "./AppListView.vue";

vi.mock("../api/apps", () => ({
  listApps: vi.fn(),
  registerApp: vi.fn(),
  getAppSpecs: vi.fn(),
}));

const listAppsMock = vi.mocked(listApps);

const response: AppListResponse = {
  apps: [
    {
      id: "app-gitea",
      name: "Gitea",
      status: "active",
      baseUrl: "https://gitea.example",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60000,
      },
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    {
      id: "app-vikunja",
      name: "Vikunja",
      status: "active",
      capabilities: {
        supportsPolling: false,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 30000,
      },
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AppListView (AR-2)", () => {
  it("renders every app with name, status, baseUrl and capabilities", async () => {
    listAppsMock.mockResolvedValue(response);

    const wrapper = mount(AppListView, { global: testGlobalOptions() });
    await flushPromises();

    const table = wrapper.get('[data-testid="app-list-table"]');
    const text = table.text();
    expect(text).toContain("Gitea");
    expect(text).toContain("Vikunja");
    expect(text).toContain("https://gitea.example");
    // Gitea's enabled capabilities.
    expect(text).toContain("polling");
    expect(text).toContain("timestamps");
    // Each row links to the app detail page.
    expect(wrapper.find('[data-testid="app-link-app-gitea"]').exists()).toBe(true);
    const links = wrapper.findAllComponents(RouterLinkStub);
    expect(links.some((link) => link.props("to") === "/apps/app-gitea")).toBe(true);
  });

  it("shows an empty state when no apps are registered", async () => {
    listAppsMock.mockResolvedValue({ apps: [] });

    const wrapper = mount(AppListView, { global: testGlobalOptions() });
    await flushPromises();

    expect(wrapper.find('[data-testid="app-list-empty"]').exists()).toBe(true);
  });

  it("surfaces a load error", async () => {
    listAppsMock.mockRejectedValue(new Error("boom"));

    const wrapper = mount(AppListView, { global: testGlobalOptions() });
    await flushPromises();

    expect(wrapper.find('[data-testid="app-list-error"]').exists()).toBe(true);
  });
});
