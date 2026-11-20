import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:8799/api';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-analyst': encodeURIComponent('测试员'), ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
}

test.describe('异常标注闭环', () => {
  test('概览页展示反馈构成与待启用草案', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '反馈闭环', exact: true })).toBeVisible();
    await expect(page.getByText('反馈构成')).toBeVisible();
    await expect(page.getByText('真实异常').first()).toBeVisible();
    await expect(page.getByText('草案 v2 待启用')).toBeVisible();
    await expect(page.getByText('闭环如何生效')).toBeVisible();
  });

  test('从队列打开异常并提交带证据的反馈', async ({ page }) => {
    const { body } = await api('/anomalies?reviewState=unreviewed');
    const anomaly = body.anomalies[0];
    expect(anomaly).toBeTruthy();

    await page.goto(`/anomalies?id=${anomaly.id}`);
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(anomaly.seriesName)).toBeVisible();

    await drawer.getByRole('button', { name: '真实异常' }).click();
    await drawer.getByLabel('证据（必填）').fill('E2E：与发布单 chg-9001 时间吻合。');
    await drawer.getByLabel('处理动作').selectOption('no_action');
    await drawer.getByRole('button', { name: '提交反馈' }).click();

    await expect(page.getByText('已提交「真实异常」')).toBeVisible();
    await expect(drawer.getByText('E2E：与发布单 chg-9001 时间吻合。')).toBeVisible();
    await expect(drawer.getByText('当前判断')).toBeVisible();
  });

  test('证据为空时无法提交', async ({ page }) => {
    const { body } = await api('/anomalies?reviewState=unreviewed');
    await page.goto(`/anomalies?id=${body.anomalies[0].id}`);
    const drawer = page.locator('aside.drawer');
    await expect(drawer.getByRole('button', { name: '提交反馈' })).toBeDisabled();
  });

  test('撤销反馈后回退到上一条有效结论', async ({ page }) => {
    const { body } = await api('/anomalies?reviewState=conflicted');
    const id = body.anomalies[0].id;
    await page.goto(`/anomalies?id=${id}`);
    const drawer = page.locator('aside.drawer');

    await drawer.getByRole('button', { name: '撤销' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('撤销这条反馈？')).toBeVisible();
    await dialog.getByLabel('撤销原因（必填）').fill('E2E：复核后撤回');
    await dialog.getByRole('button', { name: '确认撤销' }).click();

    await expect(page.getByText('反馈已撤销')).toBeVisible();
    await drawer.getByText(/已撤销的反馈/).click();
    await expect(drawer.getByText('撤销原因：E2E：复核后撤回')).toBeVisible();
  });

  test('追加不同结论需显式确认并标记冲突', async ({ page }) => {
    const { body } = await api('/anomalies?reviewState=reviewed');
    const target = body.anomalies.find((a) => a.verdict === 'true_positive' && !a.conflicted);
    await page.goto(`/anomalies?id=${target.id}`);
    const drawer = page.locator('aside.drawer');

    await drawer.getByRole('button', { name: '追加反馈' }).click();
    await drawer.getByRole('button', { name: '误报' }).click();
    await drawer.getByLabel('证据（必填）').fill('E2E：其实是压测流量。');
    await drawer.getByRole('button', { name: '提交追加反馈' }).click();

    await expect(page.getByText('已有不同结论的反馈')).toBeVisible();
    await page.getByRole('button', { name: '确认追加并标记冲突' }).click();
    await expect(page.getByText('已提交「误报」')).toBeVisible();
    await expect(drawer.getByText('结论冲突').first()).toBeVisible();
  });
});

test.describe('版本与回测', () => {
  test('显示规则差异、回测指标和采纳的反馈', async ({ page }) => {
    const { body } = await api('/versions');
    const draft = body.versions.find((v) => v.status === 'draft');
    await page.goto(`/versions?v=${draft.id}`);

    await expect(page.getByRole('heading', { name: '回测结果' })).toBeVisible();
    await expect(page.getByText('规则差异')).toBeVisible();
    await expect(page.getByText('采纳的反馈（5）')).toBeVisible();
    await expect(page.getByRole('button', { name: '启用此版本' })).toBeVisible();

    await page.getByRole('button', { name: '查看分序列明细' }).click();
    await expect(page.getByText('checkout_latency').first()).toBeVisible();
  });

  test('启用新版本后历史告警保留原版本归属', async ({ page }) => {
    const before = await api('/anomalies');
    const oldVersionIds = new Set(before.body.anomalies.map((a) => a.configVersionId));
    const { body: versions } = await api('/versions');
    const draft = versions.versions.find((v) => v.status === 'draft');

    await page.goto(`/versions?v=${draft.id}`);
    await page.getByRole('button', { name: '启用此版本' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('新规则只影响之后产生的告警')).toBeVisible();
    await dialog.getByLabel('我已核对上述规则差异与回测结果').check();
    await dialog.getByRole('button', { name: '确认启用' }).click();
    await expect(page.getByText('版本已启用')).toBeVisible();
    await expect(page.getByText(/历史告警保留原版本与原判断/)).toBeVisible();

    const after = await api('/anomalies');
    const afterOld = after.body.anomalies.filter((a) => oldVersionIds.has(a.configVersionId));
    expect(afterOld.length).toBeGreaterThan(0);
    const afterVersions = new Set(after.body.anomalies.map((a) => a.configVersionId));
    expect(afterVersions.has(draft.id)).toBe(false);
    for (const a of afterOld) {
      const orig = before.body.anomalies.find((x) => x.id === a.id);
      expect(a.configVersionId).toBe(orig.configVersionId);
      expect(a.verdict).toBe(orig.verdict);
    }
  });
});

test.describe('并发验证页', () => {
  test('并发标记恰好一次成功，并发撤销只落库一次', async ({ page }) => {
    await page.goto('/concurrency');
    await expect(page.getByRole('heading', { level: 2, name: '并发标记与撤销验证' })).toBeVisible();

    await page.getByRole('button', { name: /发起 5 个并发标记/ }).click();
    await expect(page.getByText('1 成功')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('4 冲突')).toBeVisible();
    await expect(page.getByText('没有产生重复或丢失更新')).toBeVisible();

    await page.getByRole('button', { name: /并发撤销胜出反馈/ }).click();
    await expect(page.getByText(/只有一次撤销真正落库/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('可访问性', () => {
  test('表格可通过键盘打开异常详情', async ({ page }) => {
    await page.goto('/anomalies');
    const firstRow = page.locator('table.data tbody tr.clickable').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('aside.drawer')).toBeVisible();
  });

  test('Escape 关闭抽屉', async ({ page }) => {
    const { body } = await api('/anomalies');
    await page.goto(`/anomalies?id=${body.anomalies[0].id}`);
    await expect(page.locator('aside.drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('aside.drawer')).toBeHidden();
  });
});
