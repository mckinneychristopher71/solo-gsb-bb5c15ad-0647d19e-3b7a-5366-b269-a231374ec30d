'use strict';
/*
 * 面片轨迹（panelTrajectory）单元测试 + /api/panel-trajectory HTTP 测试
 * 运行：npm test（node --test 会一并拾取本文件）
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const E = require('../public/foldEngine.js');

const L = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, [f, b]]) => [k, { front: f, back: b }]));

// 2×2 标准折帖：先沿竖线 1 向右折，再沿横线 1 向下折 → 收成 4 层单叠 @ (1,1)
const STEPS_2X2 = [
  { axis: 'v', line: 1, dir: 'r' },
  { axis: 'h', line: 1, dir: 'd' }
];

// ---------- 纯逻辑接口 ----------

test('无步骤：仅第 0 步节点，初始格位/层序/朝向', () => {
  const t = E.panelTrajectory(2, 2, {}, [], '1,0', 'front');
  assert.equal(t.ok, true);
  assert.equal(t.error, null);
  assert.equal(t.nodes.length, 1);
  assert.deepEqual(t.nodes[0], {
    step: 0, cell: '1,0', layer: 0, depth: 1,
    upFace: 'front', faceUp: true, upright: true, moved: false
  });
  // 追踪反面：初始朝下
  const b = E.panelTrajectory(2, 2, {}, [], '1,0', 'back');
  assert.equal(b.nodes[0].faceUp, false);
  assert.equal(b.nodes[0].upFace, 'front');
});

test('跨折叠追踪：2×2 两折后格位、层序、朝上/朝下、正立/倒置逐步正确', () => {
  const labels = L({ '0,0': ['4', '5'], '1,0': ['6', '3'], '0,1': ['8', '1'], '1,1': ['7', '2'] });
  const t = E.panelTrajectory(2, 2, labels, STEPS_2X2, '0,0', 'front');
  assert.equal(t.ok, true);
  assert.equal(t.error, null);
  assert.equal(t.label, '4');
  assert.equal(t.nodes.length, 3);
  // 第 0 步：原格；第 1 步：竖折翻到 (1,0) 叠顶、背面朝上；
  // 第 2 步：随上瓣下落到 (1,1) 第 2 层、正面重新朝上但页码倒置
  assert.deepEqual(t.nodes.map((n) => n.cell), ['0,0', '1,0', '1,1']);
  assert.deepEqual(t.nodes.map((n) => n.layer), [0, 0, 1]);
  assert.deepEqual(t.nodes.map((n) => n.depth), [1, 2, 4]);
  assert.deepEqual(t.nodes.map((n) => n.upFace), ['front', 'back', 'front']);
  assert.deepEqual(t.nodes.map((n) => n.faceUp), [true, false, true]);
  assert.deepEqual(t.nodes.map((n) => n.upright), [true, true, false]);
  assert.deepEqual(t.nodes.map((n) => n.moved), [false, true, true]);
});

test('叠层合并后身份延续：静止面片被压入底层，层序加深且未标记翻动', () => {
  // 追踪 (1,1) 反面：该面片两次折叠都不在移动瓣内，但被逐层压到底部
  const t = E.panelTrajectory(2, 2, {}, STEPS_2X2, '1,1', 'back');
  assert.equal(t.error, null);
  assert.deepEqual(t.nodes.map((n) => n.cell), ['1,1', '1,1', '1,1']);
  assert.deepEqual(t.nodes.map((n) => n.layer), [0, 1, 3]);
  assert.deepEqual(t.nodes.map((n) => n.depth), [1, 2, 4]);
  assert.deepEqual(t.nodes.map((n) => n.moved), [false, false, false]);
  // 始终正面朝上 → 追踪的反面始终朝下；未被水平折过 → 保持正立
  assert.deepEqual(t.nodes.map((n) => n.faceUp), [false, false, false]);
  assert.deepEqual(t.nodes.map((n) => n.upright), [true, true, true]);
});

test('moved 仅在该面片随移动纸瓣翻动时为真', () => {
  // 1×2 向右折：左格 (0,0) 移动，右格 (1,0) 静止
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const mv = E.panelTrajectory(1, 2, {}, steps, '0,0', 'front');
  assert.deepEqual(mv.nodes.map((n) => n.moved), [false, true]);
  const still = E.panelTrajectory(1, 2, {}, steps, '1,0', 'front');
  assert.deepEqual(still.nodes.map((n) => n.moved), [false, false]);
  assert.deepEqual(still.nodes.map((n) => n.layer), [0, 1]);   // 被压到底层
});

test('首个非法步骤：保留此前节点并标明中断原因，其后步骤不再追踪', () => {
  const steps = [
    { axis: 'v', line: 1, dir: 'r' },
    { axis: 'v', line: 2, dir: 'l' },   // 1 层压向 2 层：厚度冲突
    { axis: 'v', line: 1, dir: 'r' }    // 非法步之后不再追踪
  ];
  const t = E.panelTrajectory(1, 3, {}, steps, '0,0', 'front');
  assert.equal(t.ok, true);
  assert.equal(t.nodes.length, 2, '只保留第 0、1 步节点');
  assert.deepEqual(t.nodes.map((n) => n.cell), ['0,0', '1,0']);
  assert.ok(t.error);
  assert.equal(t.error.stepIndex, 1);
  assert.equal(t.error.code, 'thickness');
  assert.ok(t.error.message.includes('厚度'));
  assert.ok(t.error.conflicts.includes('2,0') && t.error.conflicts.includes('1,0'));
});

test('非法轮廓折（悬空）同样中断并给出 contour 冲突格', () => {
  const steps = [{ axis: 'v', line: 2, dir: 'r' }];   // 宽瓣右折：x=0 镜像到 x=3 悬空
  const t = E.panelTrajectory(2, 3, {}, steps, '0,0', 'front');
  assert.equal(t.nodes.length, 1);
  assert.equal(t.error.stepIndex, 0);
  assert.equal(t.error.code, 'contour');
  assert.ok(t.error.conflicts.includes('0,0'));
});

test('目标非法：bad_target / bad_grid', () => {
  assert.equal(E.panelTrajectory(2, 2, {}, [], '5,0', 'front').code, 'bad_target');
  assert.equal(E.panelTrajectory(2, 2, {}, [], '0,2', 'front').code, 'bad_target');
  assert.equal(E.panelTrajectory(2, 2, {}, [], 'abc', 'front').code, 'bad_target');
  assert.equal(E.panelTrajectory(2, 2, {}, [], null, 'front').code, 'bad_target');
  assert.equal(E.panelTrajectory(2, 2, {}, [], '0,0', 'up').code, 'bad_target');
  assert.equal(E.panelTrajectory(0, 2, {}, [], '0,0', 'front').code, 'bad_grid');
  assert.equal(E.panelTrajectory(2, 2, {}, [], '0,0', 'front').ok, true);
});

test('label 透传：追踪面的页码，空白面为 null', () => {
  const labels = L({ '0,0': ['7', ''] });
  const f = E.panelTrajectory(1, 2, labels, [], '0,0', 'front');
  assert.equal(f.label, '7');
  const b = E.panelTrajectory(1, 2, labels, [], '0,0', 'back');
  assert.equal(b.label, null);
  const none = E.panelTrajectory(1, 2, {}, [], '1,0', 'front');
  assert.equal(none.label, null);
});

test('轨迹节点与 replay 状态逐步一致（全部原格 × 正反两面交叉校验）', () => {
  const labels = L({ '0,0': ['4', '5'], '1,0': ['6', '3'], '0,1': ['8', '1'], '1,1': ['7', '2'] });
  for (const cell of ['0,0', '1,0', '0,1', '1,1']) {
    for (const face of ['front', 'back']) {
      const t = E.panelTrajectory(2, 2, labels, STEPS_2X2, cell, face);
      assert.equal(t.error, null);
      assert.equal(t.nodes.length, STEPS_2X2.length + 1);
      t.nodes.forEach((node, i) => {
        assert.equal(node.step, i);
        const r = E.replay(2, 2, labels, STEPS_2X2, i);
        assert.equal(r.error, null);
        const p = r.state.panels[cell];
        assert.equal(node.cell, `${p.cx},${p.cy}`, `${cell} 第 ${i} 步格位`);
        assert.equal(node.layer, r.state.stacks[node.cell].indexOf(cell), `${cell} 第 ${i} 步层序`);
        assert.equal(node.depth, r.state.stacks[node.cell].length);
        const vis = E.visibleFace(p);
        assert.equal(node.upFace, vis.side);
        assert.equal(node.faceUp, vis.side === face);
        assert.equal(node.upright, vis.upright);
      });
    }
  }
});

test('轨迹不改动输入：labels/steps 原样保留（保存与导入格式不变）', () => {
  const labels = L({ '0,0': ['1', '2'] });
  const steps = [{ axis: 'v', line: 1, dir: 'r' }];
  const snapshot = JSON.stringify({ labels, steps });
  E.panelTrajectory(1, 2, labels, steps, '0,0', 'front');
  assert.equal(JSON.stringify({ labels, steps }), snapshot);
});

// ---------- HTTP 接口 ----------

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-data-'));
process.env.DATA_DIR = tmpData;
const app = require('../server.js');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpData, { recursive: true, force: true });
});

async function post(p, body) {
  const resp = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: resp.status, json: await resp.json() };
}

test('POST /api/panel-trajectory：返回第 0 步到末步的完整时间线', async () => {
  const r = await post('/api/panel-trajectory', {
    rows: 2, cols: 2,
    labels: { '0,0': { front: '4', back: '5' } },
    steps: STEPS_2X2,
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.error, null);
  assert.equal(r.json.cell, '0,0');
  assert.equal(r.json.face, 'front');
  assert.equal(r.json.label, '4');
  assert.equal(r.json.nodes.length, 3);
  assert.deepEqual(r.json.nodes.map((n) => n.cell), ['0,0', '1,0', '1,1']);
  assert.deepEqual(r.json.nodes.map((n) => n.layer), [0, 0, 1]);
  assert.deepEqual(r.json.nodes.map((n) => n.depth), [1, 2, 4]);
  assert.deepEqual(r.json.nodes.map((n) => n.faceUp), [true, false, true]);
  assert.deepEqual(r.json.nodes.map((n) => n.upright), [true, true, false]);
});

test('POST /api/panel-trajectory：首个非法步骤中断并保留此前节点', async () => {
  const r = await post('/api/panel-trajectory', {
    rows: 1, cols: 3, labels: {},
    steps: [
      { axis: 'v', line: 1, dir: 'r' },
      { axis: 'v', line: 2, dir: 'l' },
      { axis: 'v', line: 1, dir: 'r' }
    ],
    target: { cell: '0,0', face: 'back' }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.nodes.length, 2);
  assert.equal(r.json.error.stepIndex, 1);
  assert.equal(r.json.error.code, 'thickness');
  assert.ok(r.json.error.conflicts.includes('1,0'));
});

test('POST /api/panel-trajectory：目标非法返回 bad_target；方案非法返回 400', async () => {
  let r = await post('/api/panel-trajectory', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '5,0', face: 'front' }
  });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'bad_target');

  r = await post('/api/panel-trajectory', {
    rows: 2, cols: 2, labels: {}, steps: [],
    target: { cell: '0,0', face: 'up' }
  });
  assert.equal(r.json.error.code, 'bad_target');

  r = await post('/api/panel-trajectory', {
    rows: 2, cols: 2, steps: [{ axis: 'z' }],
    target: { cell: '0,0', face: 'front' }
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_plan');
});

test('POST /api/panel-trajectory：末节点与 /api/simulate 末态一致', async () => {
  const body = { rows: 2, cols: 2, labels: {}, steps: STEPS_2X2 };
  const t = await post('/api/panel-trajectory', { ...body, target: { cell: '0,1', face: 'front' } });
  const sim = await post('/api/simulate', body);
  assert.equal(sim.json.ok, true);
  const last = t.json.nodes[t.json.nodes.length - 1];
  const occ = sim.json.occupied.find((o) => `${o.x},${o.y}` === last.cell);
  assert.ok(occ, '末节点格位在末态中存在');
  const idx = occ.panels.findIndex((p) => p.id === '0,1');
  assert.equal(idx, last.layer);
  assert.equal(occ.panels.length, last.depth);
});
