import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

type UploadFixture = {
  name: string;
  mimeType: string;
  body: string;
};

const testMarkerPattern = /\bWF[_-]|assistant answer must|must start|test marker|BEGIN_|END_/i;

const files = {
  feedbackDoc: {
    name: "customer-feedback-notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: "Customer feedback notes about onboarding, pricing, and support handoffs.",
  },
  budgetSheet: {
    name: "budget-review.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: "Budget, actual, forecast, owner, variance.",
  },
  qbrDeck: {
    name: "qbr-board-deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    body: "QBR deck outline with retention and pipeline slides.",
  },
  vendorPdf: {
    name: "vendor-renewal-notes.pdf",
    mimeType: "application/pdf",
    body: "Vendor renewal notes with terms, deadlines, and security addendum.",
  },
  launchMemo: {
    name: "launch-readiness-memo.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: "Launch readiness memo for Product, CS, Finance, and Legal.",
  },
  launchBudget: {
    name: "launch-budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: "Launch budget with support contractor variance.",
  },
  launchDeck: {
    name: "launch-board-deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    body: "Board deck with launch decision slides.",
  },
  vendorTerms: {
    name: "vendor-terms-summary.pdf",
    mimeType: "application/pdf",
    body: "Vendor terms summary with renewal notice and DPA clauses.",
  },
} satisfies Record<string, UploadFixture>;

async function setupMockedApp(page: Page): Promise<OpenYakMockState> {
  await seedOpenYakStorage(page);
  return mockOpenYakApi(page);
}

function expectNaturalOfficePrompt(prompt: string) {
  expect(prompt).not.toMatch(testMarkerPattern);
  expect(prompt).toMatch(/[a-z]/i);
  expect(prompt.split(/\s+/).length).toBeGreaterThan(12);
}

async function expectNoAppCrash(page: Page) {
  await expect(page.getByText("Runtime", { exact: false })).toHaveCount(0);
  await expect(page.getByText("API 401", { exact: false })).toHaveCount(0);
}

async function uploadFiles(page: Page, uploadFixtures: UploadFixture[]) {
  await page.locator('input[type="file"]').setInputFiles(
    uploadFixtures.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.body),
    })),
  );

  for (const file of uploadFixtures) {
    await expect(page.getByText(file.name)).toBeVisible();
  }
}

async function sendPrompt(page: Page, prompt: string) {
  expectNaturalOfficePrompt(prompt);
  await page.getByPlaceholder(/Describe the result you want/i).fill(prompt);
  const promptResponse = page.waitForResponse((res) =>
    res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
  try {
    await expect(page).toHaveURL(/\/c\/session-new$/, { timeout: 10_000 });
  } catch {
    await page.getByRole("option", { name: /Create a UI preflight checklist/i }).click();
    await expect(page).toHaveURL(/\/c\/session-new$/);
  }
}

async function startOfficeWorkflow(page: Page, uploadFixtures: UploadFixture[], prompt: string) {
  await page.goto("/c/new");
  await expect(page.getByRole("heading", { name: /What should (OpenYak help you do|we do in)/i })).toBeVisible();
  await uploadFiles(page, uploadFixtures);
  await sendPrompt(page, prompt);
}

function mainContent(page: Page) {
  return page.locator("#main-content");
}

test.describe("OpenYak natural office GUI workflows", () => {
  test.describe.configure({ timeout: 90_000 });

  test("memo workflow: uploaded customer notes become a VP-ready memo with owners and email copy", async ({ page }) => {
    const state = await setupMockedApp(page);
    const prompt =
      "Can you turn the attached customer feedback notes into a VP-ready memo? I need the top three themes, revenue risk, owners, and the email I can send this afternoon.";

    await startOfficeWorkflow(page, [files.feedbackDoc], prompt);

    await expect(mainContent(page).getByText("VP-ready memo").last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("Top three themes").last()).toBeVisible();
    await expect(mainContent(page).getByText("Revenue risk").last()).toBeVisible();
    await expect(mainContent(page).getByText("Owners").last()).toBeVisible();
    await expect(mainContent(page).getByText("Email draft").last()).toBeVisible();
    expect(state.fileUploads).toEqual(["customer-feedback-notes.docx"]);
    expect(JSON.stringify(state.promptBodies[0])).toContain(prompt);
    await expectNoAppCrash(page);
  });

  test("budget workflow: uploaded workbook is reviewed through budget, actual, forecast, variance, and owner questions", async ({ page }) => {
    const state = await setupMockedApp(page);
    const prompt =
      "I attached the budget workbook. Please review it like Finance would: compare budget, actuals, and forecast, call out the biggest variance, and tell me what to ask the owners.";

    await startOfficeWorkflow(page, [files.budgetSheet], prompt);

    // The Finance answer is rendered as a markdown table (see `naturalOfficeResponses.budget`
    // in tests/ui/fixtures/openyak-api.ts). The prose-heading form this test used to assert
    // ("Budget vs actuals" / "Biggest variance" / "Owner questions") was replaced in e76d3a8;
    // openyak-readme-media-light.spec.ts:175 pins the current "Finance workbook review"
    // heading and the README screenshots were regenerated from it, so the table is the
    // intended shape. None of the strings below appear in the user prompt, so they can only
    // be satisfied by the assistant answer itself.
    await expect(mainContent(page).getByText("Finance workbook review").last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("Actual / forecast signal").last()).toBeVisible();
    await expect(mainContent(page).getByText("Variance call").last()).toBeVisible();
    await expect(mainContent(page).getByText("Owner question").last()).toBeVisible();
    // The biggest variance line item, with its magnitude.
    await expect(mainContent(page).getByText("Support contractors").last()).toBeVisible();
    await expect(mainContent(page).getByText("18% over").last()).toBeVisible();
    await expect(mainContent(page).getByText("Finance recommendation").last()).toBeVisible();
    expect(state.fileUploads).toEqual(["budget-review.xlsx"]);
    expect(JSON.stringify(state.promptBodies[0])).toContain(prompt);
    await expectNoAppCrash(page);
  });

  test("deck workflow: uploaded QBR deck gets slide feedback, evidence gaps, speaker notes, and decision ask", async ({ page }) => {
    const state = await setupMockedApp(page);
    const prompt =
      "Please review this QBR deck for my VP. I need slide-by-slide feedback, gaps in the evidence, speaker-note fixes, and the decision we should ask for.";

    await startOfficeWorkflow(page, [files.qbrDeck], prompt);

    await expect(mainContent(page).getByText("QBR deck feedback").last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("Slide-by-slide").last()).toBeVisible();
    await expect(mainContent(page).getByText("Evidence gaps").last()).toBeVisible();
    await expect(mainContent(page).getByText("Speaker notes").last()).toBeVisible();
    await expect(mainContent(page).getByText("Decision ask").last()).toBeVisible();
    expect(state.fileUploads).toEqual(["qbr-board-deck.pptx"]);
    expect(JSON.stringify(state.promptBodies[0])).toContain(prompt);
    await expectNoAppCrash(page);
  });

  test("vendor workflow: renewal review returns obligations, deadlines, risks, and named owners", async ({ page }) => {
    const state = await setupMockedApp(page);
    const prompt =
      "Please read this vendor renewal and give me the renewal obligations, deadlines, risk items, named owners, and the first three actions for Legal and Procurement.";

    await startOfficeWorkflow(page, [files.vendorPdf], prompt);

    await expect(mainContent(page).getByText("Vendor renewal risk brief").last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("Obligations").last()).toBeVisible();
    await expect(mainContent(page).getByText("Deadlines").last()).toBeVisible();
    await expect(mainContent(page).getByText("Risks").last()).toBeVisible();
    await expect(mainContent(page).getByText(/Owner \/ 负责人/).last()).toBeVisible();
    await expect(mainContent(page).getByText("First three actions").last()).toBeVisible();
    expect(state.fileUploads).toEqual(["vendor-renewal-notes.pdf"]);
    expect(JSON.stringify(state.promptBodies[0])).toContain(prompt);
    await expectNoAppCrash(page);
  });

  test("board packet workflow: multi-file launch packet creates a brief, risk owners, and artifact cards", async ({ page }) => {
    const state = await setupMockedApp(page);
    const prompt =
      "I am going into the launch readiness meeting. Use the memo, workbook, deck, and vendor notes to prepare a board-ready brief, a decision workflow diagram, and a short table of open risks with owners.";

    await startOfficeWorkflow(page, [
      files.launchMemo,
      files.launchBudget,
      files.launchDeck,
      files.vendorTerms,
    ], prompt);

    await expect(mainContent(page).getByText("Board-ready launch brief", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("Executive Summary").last()).toBeVisible();
    await expect(mainContent(page).getByText("Open risks with owners").last()).toBeVisible();
    await expect(mainContent(page).getByText("Board-ready Launch Brief").last()).toBeVisible();
    await expect(mainContent(page).getByText("Launch Decision Workflow").last()).toBeVisible();
    expect(state.fileUploads).toHaveLength(4);
    expect(state.fileUploads).toEqual(expect.arrayContaining([
      "launch-readiness-memo.docx",
      "launch-budget.xlsx",
      "launch-board-deck.pptx",
      "vendor-terms-summary.pdf",
    ]));
    expect(JSON.stringify(state.promptBodies[0])).toContain(prompt);
    await expectNoAppCrash(page);
  });

  test("same-thread follow-up workflow: board brief turns into a RACI and 30-day agenda", async ({ page }) => {
    const state = await setupMockedApp(page);
    const firstPrompt =
      "I am going into the launch readiness meeting. Use the memo, workbook, deck, and vendor notes to prepare a board-ready brief, a decision workflow diagram, and a short table of open risks with owners.";
    const followUp =
      "Thanks. Now turn that into a RACI and a 30-day agenda I can send to the launch team.";

    await startOfficeWorkflow(page, [
      files.launchMemo,
      files.launchBudget,
      files.launchDeck,
      files.vendorTerms,
    ], firstPrompt);
    await expect(mainContent(page).getByText("Board-ready launch brief", { exact: true }).last()).toBeVisible({ timeout: 20_000 });

    await sendPrompt(page, followUp);

    await expect(mainContent(page).getByText("Launch team follow-up").last()).toBeVisible({ timeout: 20_000 });
    await expect(mainContent(page).getByText("RACI").last()).toBeVisible();
    await expect(mainContent(page).getByText("30-day agenda").last()).toBeVisible();
    expect(state.promptBodies).toHaveLength(2);
    expect(JSON.stringify(state.promptBodies[1])).toContain(followUp);
    await expectNoAppCrash(page);
  });
});
