// 재개발 레이더 — 서울 동별 재개발 후보 탐색기
const GCOL = { S:'#ef4444', A:'#f97316', B:'#eab308', C:'#64748b', D:'#3f4a5a' };

// 정비사업 진행단계 → 5단계 버킷(색상)
const STAGE_BUCKETS = [
  { key:'plan',  label:'초기(계획·추진위)', color:'#64748b',
    match:['정비계획','정비구역지정','추진위','안전진단','조합원 모집','조합창립','조합규약','조합설립/추진위'] },
  { key:'union', label:'조합설립',           color:'#3b82f6',
    match:['조합설립인가'] },
  { key:'impl',  label:'사업시행인가',        color:'#a855f7',
    match:['사업시행','사업계획승인','지구단위'] },
  { key:'mgmt',  label:'관리처분인가',        color:'#f97316',
    match:['관리처분'] },
  { key:'build', label:'착공·이주·준공',      color:'#22c55e',
    match:['착공','철거','이주','분양','준공'] },
];
function stageBucket(stage){
  const s = stage || '';
  for (const b of STAGE_BUCKETS) if (b.match.some(m => s.includes(m))) return b;
  return STAGE_BUCKETS[0];
}

// 주거단지 재개발/재건축만 대상 — 도심상업·도시정비형(업무/상업) 제외
// 유형 → 카테고리 (mutually exclusive). null = 비주거(제외)
const RESI_CAT = {
  '가로주택정비':'moa', '소규모재건축':'moa', '소규모재개발':'moa',   // 🏘️ 모아타운(소규모)
  '재건축':'recon', '지역주택':'recon', '리모델링':'recon',            // 🏢 재건축(아파트)
  '재개발(주택정비형)':'redev', '재개발(도시정비형)':'redev',          // 🏠 재개발(주택+역세권·재정비촉진·공공재개발)
};
const catOf = p => RESI_CAT[p.type] || ((p.name || '').includes('모아') ? 'moa' : null);
const isResi = p => catOf(p) !== null;
const MOA_TYPES = new Set(['가로주택정비', '소규모재건축', '소규모재개발']);
const isMoa = p => catOf(p) === 'moa';

// 정적 캐시된 블록정밀 격자 (백엔드 없이 가능한 동)
const PINSET_AVAILABLE = new Set(['11170_10500', '11560_12200']);

const state = {
  all: [], projects: [], subway: null, moaZones: [],
  verdict: 'all', gu: 'all', grades: new Set(['S','A','B','C','D']),
  nohu: 70, walk: 30, far: 200, q: '', sort: 'score', sel: null,
  showProjects: false, projCat: 'all', moaZone: false, showSubway: false,
  mode: 'dong',   // 'dong' | 'moa'
};

const map = L.map('map', { zoomControl:true, attributionControl:false }).setView([37.5512, 126.9882], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:19 }).addTo(map);
L.control.attribution({ prefix:false }).addAttribution('© CARTO · 건축물대장·정비사업').addTo(map);

// 지하철 노선은 동 마커 위에 보이도록 전용 pane(오버레이 400 위, 마커 600 아래)
map.createPane('subwayPane').style.zIndex = 450;
map.createPane('subwayLabelPane').style.zIndex = 460;
map.getPane('subwayLabelPane').style.pointerEvents = 'none';
const SUBWAY_LABEL_ZOOM = 13;   // 이 줌 이상에서 역 이름 표시

const subwayLayer = L.layerGroup().addTo(map); // 지하철 노선
const layer = L.layerGroup().addTo(map);      // 동 마커
const zoneLayer = L.layerGroup().addTo(map);  // 모아타운 구역
const projLayer = L.layerGroup().addTo(map);  // 실제 정비사업
const gridLayer = L.layerGroup().addTo(map);  // 블록정밀 격자
const markers = new Map();

const key = d => `${d.gu}|${d.dong}`;
const $ = s => document.querySelector(s);

// ---------- load ----------
const noCache = { cache: 'no-store' };   // 데이터 갱신이 즉시 반영되도록 캐시 우회
Promise.all([
  fetch('./data/dongs.json', noCache).then(r => r.json()),
  fetch('./data/redev_points.json', noCache).then(r => r.json()).catch(() => []),
  fetch('./data/subway.json', noCache).then(r => r.json()).catch(() => null),
  fetch('./data/moa_zones.json', noCache).then(r => r.json()).catch(() => []),
]).then(([j, proj, sub, zones]) => {
  state.all = j.dongs.filter(d => d.lat && d.lng);
  state.projects = (proj || []).filter(p => p.lat && p.lng);
  state.subway = sub;
  state.moaZones = zones || [];
  // 개발 프로젝트가 있는 (구|동) 집합 — 노후도 高·미개발 동에 별표 표시용
  state.projectDongs = new Set(state.projects.filter(isResi).map(p => `${p.gu}|${p.dong}`));
  $('#dataYear').textContent = j.year;
  $('#projCount').textContent = state.projects.length;
  $('#moaZoneN').textContent = state.moaZones.filter(z => z.n >= 2).length;
  $('#moaModeN').textContent = state.moaZones.length;
  resetControls();
  initGuOptions(); buildStageLegend(); bindUI(); apply();
}).catch(e => { $('#list').innerHTML = `<li style="padding:20px;color:#f87171">데이터 로드 실패: ${e}</li>`; });

// 브라우저 폼 복원으로 인한 슬라이더/입력 잔존값 방지 — DOM을 기본값으로 강제
function resetControls(){
  $('#nohuRange').value = 70; $('#nohuVal').textContent = '70';
  $('#walkRange').value = 30; $('#walkVal').textContent = '전체';
  $('#farRange').value = 200; $('#farVal').textContent = '200%';
  $('#search').value = ''; $('#sortSel').value = 'score';
  $('#guSel').value = 'all'; $('#projToggle').checked = false;
  $('#moaZone').checked = false; $('#subwayToggle').checked = false;
  document.querySelectorAll('#gradeFilter input').forEach(i => i.checked = true);
  $('#moaModeBtn').classList.remove('active');
  Object.assign(state, { verdict:'all', gu:'all', grades:new Set(['S','A','B','C','D']),
    nohu:70, walk:30, far:200, q:'', sort:'score', showProjects:false, projCat:'all', moaZone:false, showSubway:false, mode:'dong' });
}

function initGuOptions(){
  const gus = [...new Set(state.all.map(d => d.gu))].sort((a,b)=>a.localeCompare(b,'ko'));
  const sel = $('#guSel');
  gus.forEach(g => { const o=document.createElement('option'); o.value=g; o.textContent=g; sel.appendChild(o); });
}

// ---------- filtering ----------
function apply(){
  let r = state.all.filter(d =>
    (state.verdict==='all' || d.verdict===state.verdict) &&
    (state.gu==='all' || d.gu===state.gu) &&
    state.grades.has(d.grade) &&
    (d.nohu||0) >= state.nohu &&
    (state.walk>=30 || (d.walk_min!=null && d.walk_min<=state.walk)) &&
    (state.far>=800 || d.est_far==null || d.est_far<=state.far)
  );
  if (state.q){
    const q = state.q.trim().toLowerCase();
    r = r.filter(d => (d.dong+d.gu).toLowerCase().includes(q));
  }
  const cmp = {
    score: (a,b)=>(b.score||0)-(a.score||0),
    nohu:  (a,b)=>(b.nohu||0)-(a.nohu||0),
    walk:  (a,b)=>(a.walk_min??999)-(b.walk_min??999),
    far:   (a,b)=>(a.est_far??9999)-(b.est_far??9999),
  }[state.sort];
  r.sort(cmp);
  state.filtered = r;
  renderSummary(); renderList(); renderMarkers();
  if (state.mode === 'moa') renderMoaList();   // 모아타운 조회 모드는 리스트를 구역으로 덮어씀
}

function renderSummary(){
  const counts = { S:0,A:0,B:0,C:0,D:0 };
  state.filtered.forEach(d => counts[d.grade]!=null && counts[d.grade]++);
  const cand = state.filtered.filter(d=>d.verdict==='후보').length;
  $('#summary').innerHTML =
    `<div class="chip" title="현재 필터의 미지정 후보"><b style="color:#7dd3fc">${cand}</b><span>🎯 후보</span></div>` +
    ['S','A','B','C'].map(g =>
      `<div class="chip"><b class="g-${g}">${counts[g]}</b><span>${g}등급</span></div>`).join('');
}

function renderList(){
  $('#resultCount').textContent = `${state.filtered.length}개 동`;
  const html = state.filtered.slice(0,400).map(d => {
    const k = key(d);
    const walk = d.walk_min!=null ? `🚇 ${d.walk_min}분` : '';
    return `<li class="item ${state.sel===k?'sel':''}" data-k="${k}">
      <div class="gbadge ${d.grade}">${d.grade}</div>
      <div class="iname"><b>${d.dong}</b>
        <span>${d.gu} · 노후 ${fmt(d.nohu)}% ${walk}</span>
        <div><span class="vtag v${d.verdict}">${d.verdict}</span></div></div>
      <div class="iscore"><b>${Math.round(d.score)}</b>점</div>
    </li>`;
  }).join('');
  const ul = $('#list');
  ul.innerHTML = html || '<li style="padding:24px;text-align:center;color:#8b97a6">조건에 맞는 동이 없습니다</li>';
  ul.querySelectorAll('.item').forEach(li => li.addEventListener('click', () => select(li.dataset.k, true)));
}

function renderMarkers(){
  layer.clearLayers(); markers.clear();
  state.filtered.forEach(d => {
    const k = key(d);
    const r = 5 + (d.score-30)/8;
    const sel = state.sel===k;
    const m = L.circleMarker([d.lat, d.lng], {
      radius: Math.max(5, r), color: sel ? '#fff' : (GCOL[d.grade]||'#666'),
      weight: sel ? 3 : 1.5,
      fillColor: GCOL[d.grade]||'#666', fillOpacity: sel ? .25 : .08,  // 노후도 원=투명(테두리만)
    });
    m.on('click', () => select(k, false));
    m.bindTooltip(`${d.dong} · ${d.grade}등급 ${Math.round(d.score)}점`, {direction:'top'});
    m.addTo(layer); markers.set(k, m);
    // 노후도 高(≥70) & 개발 프로젝트 없음 → 작은 별 (미지정 발굴 기회)
    if ((d.nohu||0) >= 70 && state.projectDongs && !state.projectDongs.has(k)){
      L.marker([d.lat, d.lng], { interactive:false, keyboard:false,
        icon: L.divIcon({ className:'', html:'<div class="star-mark">★</div>', iconSize:[14,14], iconAnchor:[7,7] })
      }).addTo(layer);
    }
  });
}

// ---------- 실제 정비사업 레이어 ----------
function renderProjects(){
  projLayer.clearLayers(); zoneLayer.clearLayers();
  const on = state.showProjects;
  $('#stageLegend').classList.toggle('hidden', !on);
  $('#projCat').classList.toggle('hidden', !on);
  const zoneable = on && state.projCat==='moa';
  $('#moaZoneWrap').classList.toggle('hidden', !zoneable);
  const resiTotal = state.projects.filter(isResi).length;
  if (!on){ $('#projCount').textContent = resiTotal; return; }
  const cat = state.projCat;
  const list = state.projects.filter(p => {
    const c = catOf(p); if (!c) return false;      // 비주거 제외
    return cat === 'all' || c === cat;
  });
  $('#projCount').textContent = list.length;

  // 모아타운 '구역으로 묶기' 모드 — 개별 대신 클러스터 구역 표시
  if (zoneable && state.moaZone){ renderMoaZones(); return; }

  list.forEach(p => {
    const b = stageBucket(p.stage), moa = isMoa(p);
    L.circleMarker([p.lat, p.lng], {
      radius: moa?9:8, color: moa?'#22d3ee':'#0b0f14', weight: moa?2.5:1.5,
      fillColor:b.color, fillOpacity:.95,
    }).bindTooltip(`${p.name||'(이름없음)'}<br>${moa?'🏘️ ':''}${p.type||''} · ${p.stage||'-'}`, {direction:'top'})
      .on('click', () => showZoneDetail(p))
      .addTo(projLayer);
  });
}

function renderMoaZones(){
  zoneLayer.clearLayers();
  state.moaZones.forEach(z => {
    L.circle([z.lat, z.lng], { radius:z.r, color:'#22d3ee', weight:1.5,
      fillColor:'#22d3ee', fillOpacity: z.n>=2 ? .16 : .07 })
      .bindTooltip(`<b>${z.gu} ${z.dong} 일대</b><br>모아타운 추정구역 · 소규모정비 ${z.n}곳<br>${z.names.slice(0,3).join('<br>')}${z.n>3?'<br>…':''}`,
        {direction:'top'})
      .addTo(zoneLayer);
    if (z.n >= 2){
      L.marker([z.lat, z.lng], { icon: L.divIcon({ className:'', html:`<div class="moa-count">${z.n}</div>`,
        iconSize:[22,22], iconAnchor:[11,11] }) }).addTo(zoneLayer);
    }
  });
}

// ---------- 지하철 노선도 ----------
function renderSubway(){
  subwayLayer.clearLayers();
  if (!state.showSubway || !state.subway) return;
  const showNames = map.getZoom() >= SUBWAY_LABEL_ZOOM;
  const seen = new Set();
  state.subway.lines.forEach(ln => {
    const pts = ln.stations.map(s => [s.lat, s.lng]);
    L.polyline(pts, { pane:'subwayPane', color:ln.color, weight:4.5, opacity:.95 }).addTo(subwayLayer);
    ln.stations.forEach(s => {
      L.circleMarker([s.lat, s.lng], { pane:'subwayPane', radius:3, color:'#fff', weight:1.2,
        fillColor:ln.color, fillOpacity:1 })
        .bindTooltip(`${s.name} · ${ln.name}`, {direction:'top'})
        .addTo(subwayLayer);
      // 역 이름 라벨 — 줌인 시에만, 환승 중복 제거
      if (showNames && !seen.has(s.name)){
        seen.add(s.name);
        L.marker([s.lat, s.lng], { pane:'subwayLabelPane', interactive:false,
          icon: L.divIcon({ className:'subway-label', html:s.name, iconSize:[0,0], iconAnchor:[-5,6] }) })
          .addTo(subwayLayer);
      }
    });
  });
}
// 줌 변경 시 라벨 표시/숨김 갱신
map.on('zoomend', () => { if (state.showSubway) renderSubway(); });

// ---------- 정비사업 구역 상세 (점 클릭) ----------
const CAT_LABEL = { recon:'🏢 재건축', redev:'🏠 재개발', moa:'🏘️ 모아타운' };
function showZoneDetail(p){
  const b = stageBucket(p.stage), cat = catOf(p);
  const curIdx = STAGE_BUCKETS.findIndex(x => x.key === b.key);
  const steps = STAGE_BUCKETS.map((s,i) =>
    `<div class="zstep ${i<=curIdx?'done':''}" style="--c:${s.color}"><i></i><span>${s.label.split('(')[0]}</span></div>`).join('');
  $('#detailBody').innerHTML = `
    <div class="dbody">
      <div class="dhead">
        <div class="gbadge" style="background:${b.color};color:#fff">${(CAT_LABEL[cat]||'🏗️').slice(0,2)}</div>
        <div><h2 style="font-size:18px;line-height:1.25">${p.name||'(이름없음)'}</h2>
          <div class="dgu">${p.gu} ${p.dong||''} · ${CAT_LABEL[cat]||p.type}</div></div>
      </div>
      <div class="zstage" style="border-color:${b.color}">
        <span class="zstage-lbl">현재 진행 단계</span>
        <span class="zstage-v" style="color:${b.color}">${p.stage||'-'}</span>
      </div>
      <div class="zsteps">${steps}</div>
      <div class="dmetrics">
        <div class="metric"><div class="mk">사업 유형</div><div class="mv" style="font-size:14px">${p.type||'-'}</div></div>
        <div class="metric"><div class="mk">위치</div><div class="mv" style="font-size:14px">${p.gu} ${p.dong||''}</div></div>
      </div>
      <div class="disclaimer">서울 정비사업 정보몽땅 기준 진행단계입니다. 조합·시공사·일정 등 최신 세부는 자치구·조합 고시를 별도 확인하세요.</div>
    </div>`;
  $('#detail').classList.remove('hidden');
}

function buildStageLegend(){
  $('#stageLegend').innerHTML = STAGE_BUCKETS.map(b =>
    `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('') +
    `<span style="margin-top:2px"><i style="background:transparent;border:2px solid #22d3ee"></i>🏘️ 모아타운(청록 테두리)</span>`;
}

// ---------- selection / detail ----------
function select(k, fromList){
  state.sel = k;
  const d = state.all.find(x => key(x)===k);
  if (!d) return;
  gridLayer.clearLayers();
  showDetail(d);
  renderList(); renderMarkers();
  if (fromList){
    const li = document.querySelector(`.item[data-k="${CSS.escape(k)}"]`);
    li && li.scrollIntoView({block:'nearest'});
  }
  if (fromList && Number.isFinite(d.lat) && Number.isFinite(d.lng)){
    try { map.setView([d.lat, d.lng], Math.max(map.getZoom(), 15), { animate:true }); } catch(_){}
  }
}

function bar(label, val, max, color){
  const pct = Math.max(0, Math.min(100, val/max*100));
  return `<div class="dbar"><div class="bl"><span>${label}</span><span>${fmt(val)}</span></div>
    <div class="bartrack"><div class="barfill" style="width:${pct}%;background:${color}"></div></div></div>`;
}

function showDetail(d){
  const gridKey = `${d.sgg}_${d.bjd}`;
  const hasGrid = PINSET_AVAILABLE.has(gridKey);
  const walk = d.walk_min!=null ? `${d.walk_min}분 <small>(${d.station_dist}m)</small>` : '—';
  // 추정 용적률: 대지면적 누락으로 30% 미만·미상은 신뢰불가 → 저밀 표기
  const far  = (d.est_far!=null && d.est_far>=30) ? `${fmt(d.est_far)}%`
             : `<span style="color:#8b97a6;font-size:13px">저밀 <small>(추정한계)</small></span>`;
  const slope= d.avg_slope!=null ? `${fmt(d.avg_slope)}°` : '—';
  const note = d.note ? `<div class="dnote"><b>비고</b> · ${d.note}</div>` : '';
  $('#detailBody').innerHTML = `
    <div class="dbody">
      <div class="dhead">
        <div class="gbadge ${d.grade}">${d.grade}</div>
        <div><h2>${d.dong}</h2><div class="dgu">${d.gu} · ${d.subtype} · <span class="vtag v${d.verdict}">${d.verdict}</span></div></div>
      </div>
      <div class="dscore"><span class="big">${Math.round(d.score)}</span><span class="lbl">/ 100 종합 재개발 점수</span></div>
      ${bar('노후도 (30년+ 비율)', d.nohu, 100, GCOL[d.grade])}
      ${bar('저층 비율 (1~3층)', d.lowrise, 100, '#22c55e')}
      <div class="dmetrics">
        <div class="metric"><div class="mk">평균 연식</div><div class="mv">${fmt(d.avg_age)}<small> 년</small></div></div>
        <div class="metric"><div class="mk">평균 층수</div><div class="mv">${fmt(d.avg_floor)}<small> 층</small></div></div>
        <div class="metric"><div class="mk">추정 용적률</div><div class="mv">${far}</div></div>
        <div class="metric"><div class="mk">역세권 도보</div><div class="mv">${walk}</div></div>
        <div class="metric"><div class="mk">건물 수 / 노후</div><div class="mv">${d.buildings}<small> / ${d.old} 노후</small></div></div>
        <div class="metric"><div class="mk">평균 경사</div><div class="mv">${slope}</div></div>
      </div>
      ${note}
      <button class="dbtn ${hasGrid?'':'off'}" id="gridBtn" ${hasGrid?'':'disabled'}>
        ${hasGrid ? '🔬 블록정밀 격자 보기 (100m)' : '🔬 블록정밀 — 이 동은 캐시 없음(백엔드 필요)'}
      </button>
      ${simHtml(d)}
      <div class="disclaimer">
        ※ 건축물대장(국토부) 표본 기반 추정치. 종합점수 = 노후도·사업성(저층·용적·역세권)·연식·용도 가중합.
        실제 정비사업 지정·진행은 자치구·서울시 고시를 별도 확인하세요. 투자 판단 책임은 본인에게 있습니다.
      </div>
    </div>`;
  $('#detail').classList.remove('hidden');
  if (hasGrid) $('#gridBtn').addEventListener('click', () => loadGrid(gridKey, d));
  bindSim(d);
}

// ---------- 블록정밀 격자 ----------
const LATG = 0.0009, LNGG = 0.00114;
function gridColor(ratio){
  if (ratio >= 85) return '#ef4444';
  if (ratio >= 70) return '#f97316';
  if (ratio >= 50) return '#eab308';
  return '#64748b';
}
function loadGrid(gridKey, d){
  const btn = $('#gridBtn'); btn.textContent = '⏳ 격자 불러오는 중…';
  fetch(`./data/pinset/${gridKey}.json`).then(r => r.json()).then(g => {
    gridLayer.clearLayers();
    const cells = g.cells || [];
    const b = [];
    cells.forEach(c => {
      const bounds = [[c.lat-LATG/2, c.lng-LNGG/2],[c.lat+LATG/2, c.lng+LNGG/2]];
      L.rectangle(bounds, { color:'#0b0f14', weight:1, fillColor:gridColor(c.ratio), fillOpacity:.6 })
        .bindTooltip(`노후 ${c.ratio}% (${c.old}/${c.total}동)`, {direction:'top'})
        .addTo(gridLayer);
      b.push([c.lat, c.lng]);
    });
    if (b.length) map.fitBounds(b, { padding:[40,40], maxZoom:17 });
    btn.textContent = `🔬 블록정밀 ${cells.length}격자 표시중 (노후율 색상)`;
  }).catch(() => { btn.textContent = '🔬 격자 로드 실패'; });
}

// ---------- 투자 시뮬 (추정 분담금) ----------
function simHtml(d){
  return `
  <div class="sim" id="sim">
    <div class="sim-head" id="simHead">💰 투자 시뮬 — 추정 분담금<span class="chev">▾</span></div>
    <div class="sim-body">
      <div class="sim-in"><label>매입가 (실투입 원가, 억원)</label><input type="number" id="s_buy" value="6" min="0" step="0.5"></div>
      <div class="sim-in"><label>권리가액 (감정평가, 억원)</label><input type="number" id="s_right" value="4.5" min="0" step="0.5"></div>
      <div class="sim-in"><label>분양받을 평형 (평)</label><input type="number" id="s_unit" value="25" min="1"></div>
      <div class="sim-in"><label>조합원 분양가 (만원/평)</label><input type="number" id="s_jprice" value="3600" min="0" step="100"></div>
      <div class="sim-in"><label>신축 예상시세 (만원/평)</label><input type="number" id="s_mprice" value="5000" min="0" step="100"></div>
      <div class="sim-out" id="simOut"></div>
      <div class="sim-note">단순 교육용 추정. 사업비·이주비·금융비·취득세·사업기간(보통 10년+)·미동의 리스크는 반영하지 않습니다.
        분담금=조합원분양가−권리가액, 총투입=매입가+분담금, 차익=신축시세−총투입.</div>
    </div>
  </div>`;
}
function bindSim(d){
  const sim = $('#sim');
  $('#simHead').addEventListener('click', () => sim.classList.toggle('open'));
  const ids = ['s_buy','s_right','s_unit','s_jprice','s_mprice'];
  const money = m => {                          // m: 만원
    const eok = m/10000;
    return Math.abs(eok) >= 1
      ? (eok.toFixed(2).replace(/\.?0+$/,'')) + '억'
      : Math.round(m).toLocaleString() + '만원';
  };
  const calc = () => {
    const v = id => parseFloat($('#'+id).value) || 0;
    const buy=v('s_buy')*10000, right=v('s_right')*10000,
          unit=v('s_unit'), jp=v('s_jprice'), mp=v('s_mprice');
    const cost  = unit * jp;        // 조합원분양가 총액
    const share = cost - right;     // 추정 분담금
    const total = buy + share;      // 총 투입 = 매입가 + 분담금
    const asset = unit * mp;        // 신축 예상자산
    const gain  = asset - total;    // 예상 차익
    const roi   = total ? gain/total*100 : 0;
    const cls = gain>=0 ? 'pos' : 'neg';
    const sgn = x => x>=0 ? '+' : '−';
    $('#simOut').innerHTML = `
      <div class="sim-row"><span class="k">조합원 분양가</span><span class="v">${money(cost)}</span></div>
      <div class="sim-row"><span class="k">추정 분담금</span><span class="v">${sgn(share)}${money(Math.abs(share))}</span></div>
      <div class="sim-row"><span class="k">총 투입 (매입가+분담금)</span><span class="v">${money(total)}</span></div>
      <div class="sim-row"><span class="k">신축 예상자산</span><span class="v">${money(asset)}</span></div>
      <div class="sim-row hl"><span class="k">예상 차익</span><span class="v ${cls}">${sgn(gain)}${money(Math.abs(gain))} (${sgn(roi)}${Math.abs(roi).toFixed(0)}%)</span></div>`;
  };
  ids.forEach(id => $('#'+id).addEventListener('input', calc));
  calc();
}

$('#detailClose').addEventListener('click', () => {
  $('#detail').classList.add('hidden'); gridLayer.clearLayers();
  state.sel=null; renderList(); renderMarkers();
});

// ---------- 모아타운 구역 조회 모드 ----------
function enterMoaMode(){
  state.mode = 'moa';
  $('#moaModeBtn').classList.add('active');
  $('#verdictSeg').querySelectorAll('button').forEach(x=>x.classList.remove('active'));
  // 지도도 모아타운 구역 레이어로 자동 전환
  state.showProjects = true; $('#projToggle').checked = true;
  state.projCat = 'moa';
  $('#projCat').querySelectorAll('button').forEach(x=>x.classList.toggle('active', x.dataset.c==='moa'));
  state.moaZone = true; $('#moaZone').checked = true;
  renderProjects();
  apply();   // apply() 끝에서 renderMoaList() 호출
}
function exitMoaMode(){
  if (state.mode==='dong') return;
  state.mode = 'dong';
  $('#moaModeBtn').classList.remove('active');
  state.moaZone = false; $('#moaZone').checked = false;
  renderProjects();
}

function renderMoaList(){
  const gu = state.gu, q = state.q.trim().toLowerCase();
  let zones = state.moaZones.filter(z =>
    (gu==='all' || z.gu===gu) &&
    (!q || (z.dong+z.gu+z.names.join('')).toLowerCase().includes(q)));
  zones = zones.sort((a,b)=> b.n-a.n || a.gu.localeCompare(b.gu,'ko'));
  const total = zones.reduce((s,z)=>s+z.n,0);
  $('#resultCount').textContent = `${zones.length}개 구역 · ${total}개 사업`;
  $('#summary').innerHTML =
    `<div class="chip"><b style="color:#22d3ee">${zones.length}</b><span>🏘️ 모아 구역</span></div>` +
    `<div class="chip"><b>${zones.filter(z=>z.n>=2).length}</b><span>다중사업</span></div>` +
    `<div class="chip"><b>${total}</b><span>소규모정비</span></div>` +
    `<div class="chip"><b>${new Set(zones.map(z=>z.gu)).size}</b><span>자치구</span></div>`;
  const ul = $('#list');
  ul.innerHTML = zones.map((z,i) => `<li class="item" data-z="${i}">
      <div class="zbadge">${z.n}</div>
      <div class="iname"><b>${z.dong} 일대</b>
        <span>${z.gu} · ${z.stage||'-'}</span>
        <div><span class="vtag v진행중">${z.names[0].length>22?z.names[0].slice(0,22)+'…':z.names[0]}</span></div></div>
    </li>`).join('') || '<li style="padding:24px;text-align:center;color:#8b97a6">조건에 맞는 구역이 없습니다</li>';
  ul.querySelectorAll('.item').forEach(li => li.addEventListener('click', () => {
    const z = zones[+li.dataset.z];
    map.setView([z.lat, z.lng], 16, { animate:true });
    const members = z.names.map(n=>`• ${n}`).join('<br>') + (z.n>z.names.length?`<br>…외 ${z.n-z.names.length}곳`:'');
    L.popup({ maxWidth:280 }).setLatLng([z.lat, z.lng])
      .setContent(`<b>${z.gu} ${z.dong} 일대</b><br>모아타운 추정구역 · 소규모정비 ${z.n}곳<br><br>${members}`)
      .openOn(map);
  }));
}

// ---------- 통계 대시보드 ----------
function openDash(){
  const all = state.all, proj = state.projects.filter(isResi);   // 주거단지 재개발·재건축만
  const catCnt = { recon:0, redev:0, moa:0 };
  proj.forEach(p => { const c=catOf(p); if(catCnt[c]!=null) catCnt[c]++; });
  const cand = all.filter(d=>d.verdict==='후보');
  const avgNohu = all.reduce((s,d)=>s+(d.nohu||0),0)/all.length;
  const gradeCnt = {S:0,A:0,B:0,C:0,D:0}; all.forEach(d=>gradeCnt[d.grade]!=null&&gradeCnt[d.grade]++);
  // 자치구별 후보수
  const byGu = {};
  cand.forEach(d => { byGu[d.gu] = byGu[d.gu]||{n:0,nohu:0}; byGu[d.gu].n++; byGu[d.gu].nohu+=d.nohu; });
  const guRank = Object.entries(byGu).map(([g,o])=>({gu:g,n:o.n,nohu:o.nohu/o.n}))
    .sort((a,b)=>b.n-a.n);
  const maxGu = Math.max(...guRank.map(g=>g.n), 1);
  // 정비사업 단계 분포
  const stageCnt = {}; STAGE_BUCKETS.forEach(b=>stageCnt[b.key]={label:b.label,color:b.color,n:0});
  proj.forEach(p => { stageCnt[stageBucket(p.stage).key].n++; });
  const maxGrade = Math.max(...Object.values(gradeCnt),1);
  const maxStage = Math.max(...Object.values(stageCnt).map(s=>s.n),1);
  // 모아타운(소규모주택정비) 구별 분포
  const moa = proj.filter(isMoa);
  const byGuMoa = {}; moa.forEach(p => byGuMoa[p.gu]=(byGuMoa[p.gu]||0)+1);
  const moaRank = Object.entries(byGuMoa).map(([g,n])=>({gu:g,n})).sort((a,b)=>b.n-a.n);
  const maxMoa = Math.max(...moaRank.map(m=>m.n),1);

  $('#dashBody').innerHTML = `
    <h2>📊 서울 재개발 통계</h2>
    <div class="dsub">건축물대장 ${state.all.length?$('#dataYear').textContent:''} · 377개 동 · 주거단지 재개발·재건축 ${proj.length}곳(추진중)</div>
    <div class="dstat">
      <div class="box"><b style="color:#7dd3fc">${cand.length}</b><span>🎯 미지정 후보 동</span></div>
      <div class="box"><b>${catCnt.recon}</b><span>🏢 재건축</span></div>
      <div class="box"><b>${catCnt.redev}</b><span>🏠 재개발</span></div>
      <div class="box"><b style="color:#22d3ee">${catCnt.moa}</b><span>🏘️ 모아타운</span></div>
    </div>
    <div class="dsection">
      <h3>자치구별 미지정 후보 동 (상위 ${Math.min(guRank.length,15)})</h3>
      ${guRank.slice(0,15).map(g=>`<div class="gbar">
        <span class="gn">${g.gu}</span>
        <span class="gt"><span class="gf" style="width:${g.n/maxGu*100}%;background:#3b82f6"></span></span>
        <span class="gv">${g.n}개 · 노후${g.nohu.toFixed(0)}%</span></div>`).join('')}
    </div>
    <div class="dsection">
      <h3>종합점수 등급 분포 (전체 377동)</h3>
      ${['S','A','B','C','D'].map(g=>`<div class="gbar">
        <span class="gn g-${g}" style="font-weight:800">${g}등급</span>
        <span class="gt"><span class="gf" style="width:${gradeCnt[g]/maxGrade*100}%;background:${GCOL[g]}"></span></span>
        <span class="gv">${gradeCnt[g]}동</span></div>`).join('')}
    </div>
    <div class="dsection">
      <h3>실제 정비사업 진행단계 (${proj.length}곳)</h3>
      ${STAGE_BUCKETS.map(b=>{const s=stageCnt[b.key];return `<div class="gbar">
        <span class="gn" style="width:120px">${b.label}</span>
        <span class="gt"><span class="gf" style="width:${s.n/maxStage*100}%;background:${b.color}"></span></span>
        <span class="gv">${s.n}곳</span></div>`}).join('')}
    </div>
    <div class="dsection">
      <h3>🏘️ 자치구별 모아타운·소규모주택정비 (${moa.length}곳, 상위 ${Math.min(moaRank.length,15)})</h3>
      ${moaRank.slice(0,15).map(m=>`<div class="gbar">
        <span class="gn">${m.gu}</span>
        <span class="gt"><span class="gf" style="width:${m.n/maxMoa*100}%;background:#22d3ee"></span></span>
        <span class="gv">${m.n}곳</span></div>`).join('')}
    </div>`;
  $('#dash').classList.remove('hidden');
}

// ---------- UI bindings ----------
function bindUI(){
  $('#verdictSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    exitMoaMode();
    $('#verdictSeg').querySelectorAll('button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); state.verdict=b.dataset.v; apply();
  });
  $('#moaModeBtn').addEventListener('click', () => {
    if (state.mode==='moa'){ exitMoaMode(); apply(); }   // 토글 — 다시 누르면 동 조회로
    else enterMoaMode();
  });
  $('#guSel').addEventListener('change', e => { state.gu=e.target.value; apply(); });
  $('#gradeFilter').addEventListener('change', () => {
    state.grades = new Set([...document.querySelectorAll('#gradeFilter input:checked')].map(i=>i.value)); apply();
  });
  $('#nohuRange').addEventListener('input', e => { state.nohu=+e.target.value; $('#nohuVal').textContent=e.target.value; apply(); });
  $('#walkRange').addEventListener('input', e => {
    state.walk=+e.target.value;
    $('#walkVal').textContent = +e.target.value>=30 ? '전체' : e.target.value+'분'; apply();
  });
  $('#farRange').addEventListener('input', e => {
    state.far=+e.target.value;
    $('#farVal').textContent = +e.target.value>=800 ? '전체' : e.target.value+'%'; apply();
  });
  let t; $('#search').addEventListener('input', e => { clearTimeout(t); t=setTimeout(()=>{ state.q=e.target.value; apply(); },180); });
  $('#sortSel').addEventListener('change', e => { state.sort=e.target.value; apply(); });
  $('#projToggle').addEventListener('change', e => { state.showProjects=e.target.checked; renderProjects(); });
  $('#projCat').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#projCat').querySelectorAll('button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); state.projCat=b.dataset.c;
    if (b.dataset.c!=='moa' && state.mode==='moa'){ exitMoaMode(); apply(); }
    renderProjects();
  });
  $('#moaZone').addEventListener('change', e => { state.moaZone=e.target.checked; renderProjects(); });
  $('#subwayToggle').addEventListener('change', e => { state.showSubway=e.target.checked; renderSubway(); });
  $('#dashBtn').addEventListener('click', openDash);
  $('#dashClose').addEventListener('click', () => $('#dash').classList.add('hidden'));
  $('#dash').addEventListener('click', e => { if (e.target.id==='dash') $('#dash').classList.add('hidden'); });
}

function fmt(v){ return v==null ? '—' : (Math.round(v*10)/10).toLocaleString(); }
