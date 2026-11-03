// 재개발 레이더 — 서울 동별 재개발 후보 탐색기
const GCOL = { S:'#ef4444', A:'#f97316', B:'#ca8a04', C:'#64748b', D:'#94a3b8' };

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
  { key:'build', label:'착공·이주·분양',      color:'#22c55e',
    match:['착공','철거','이주','분양','준공'] },
];
function stageBucket(stage){
  const s = stage || '';
  for (const b of STAGE_BUCKETS) if (b.match.some(m => s.includes(m))) return b;
  return STAGE_BUCKETS[0];
}

// 추진방식(사업종류) 분류 — 이름/유형에서 추출. 신통·공공은 이름에 명시됨
const METHODS = [
  { key:'신통',     label:'신통기획',        color:'#ef4444', test:n=>/신속통합|신통기획/.test(n) },
  { key:'공공재개발', label:'공공재개발',      color:'#2563eb', test:n=>n.includes('공공재개발') },
  { key:'공공재건축', label:'공공재건축',      color:'#1d4ed8', test:n=>n.includes('공공재건축') },
  { key:'도심공공',   label:'도심공공복합',    color:'#16a34a', test:n=>/도심\s?공공/.test(n) },
  { key:'역세권',     label:'역세권 장기전세', color:'#f59e0b', test:n=>n.includes('역세권')&&n.includes('장기전세') },
  { key:'촉진',       label:'재정비촉진(뉴타운)', color:'#a855f7', test:n=>/재정비촉진|촉진구역/.test(n) },
];
function methodOf(p){
  const n = p.name || '';
  // 이름에 '공공'이 없는 공공재개발 등 — 큐레이션(curated_plans.json)의 method가 우선
  const cm = curatedPlan(p)?.method;
  if (cm){ const m = METHODS.find(x => x.key === cm); if (m) return m; }
  for (const m of METHODS) if (m.test(n)) return m;
  const t = p.type;
  if (['가로주택정비','소규모재건축','소규모재개발'].includes(t) || n.includes('모아')) return { key:'모아', label:'모아타운·소규모', color:'#0e7490' };
  if (t === '지역주택') return { key:'지주택', label:'지역주택조합', color:'#ca8a04' };
  if (t === '리모델링') return { key:'리모델링', label:'리모델링', color:'#94a3b8' };
  return { key:'민간', label:'민간정비', color:'#64748b' };
}

// 주거단지 재개발/재건축만 대상 — 도심상업·도시정비형(업무/상업) 제외
// 유형 → 카테고리 (mutually exclusive). null = 비주거(제외)
const RESI_CAT = {
  '가로주택정비':'moa', '소규모재건축':'moa', '소규모재개발':'moa',   // 🏘️ 모아타운(소규모)
  '재건축':'recon', '지역주택':'recon', '리모델링':'recon',            // 🏢 재건축(아파트)
  '재개발(주택정비형)':'redev', '재개발(도시정비형)':'redev',          // 🏠 재개발(주택+역세권·재정비촉진·공공재개발)
};
// 아파트가 안 올라가는 비주거(업무·오피스·지식산업) 제외
const NON_APT = /업무지구|오피스|지식산업/;
const catOf = p => NON_APT.test(p.name || '') ? null
  : (RESI_CAT[p.type] || ((p.name || '').includes('모아') ? 'moa' : null));
const isResi = p => catOf(p) !== null;
const MOA_TYPES = new Set(['가로주택정비', '소규모재건축', '소규모재개발']);
const isMoa = p => catOf(p) === 'moa';

// 정적 캐시된 블록정밀 격자 (백엔드 없이 가능한 동)
const PINSET_AVAILABLE = new Set(['11170_10500', '11560_12200']);

const state = {
  all: [], projects: [], subway: null, moaZones: [],
  verdict: 'all', gu: 'all', grades: new Set(['S','A','B','C','D']),
  nohu: 70, walk: 30, far: 200, q: '', sort: 'score', sel: null,
  resiOnly: true,   // 주거사업 없는 도심상업지(명동·을지로 등) 제외 — 주거 재개발 탐색이 기본
  showProjects: false, projCat: 'all', moaZone: false, showSubway: true,
  mode: 'dong',   // 'dong' | 'moa'
  compare: [],    // 비교 담은 동 key 목록 (최대 4)
  colorBy: 'stage', // 정비사업 점 색상 기준: 'stage'(진행단계) | 'method'(추진방식)
  stageFilter: null, methodFilter: null,  // 범례 클릭 필터(활성 key Set) — 로드 시 전체로 초기화
};
const STAGE_KEYS = ['plan','union','impl','mgmt','build'];
const METHOD_KEYS = ['신통','공공재개발','공공재건축','도심공공','역세권','촉진','모아','지주택','리모델링','민간'];

const map = L.map('map', { zoomControl:true, attributionControl:false }).setView([37.5512, 126.9882], 11);
// CARTO 무료 타일이 'API KEY REQUIRED' 워터마크로 바뀌어 키 불필요한 OSM으로 교체(한글 지명)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, className:'base-tiles' }).addTo(map);
L.control.attribution({ prefix:false }).addAttribution('© OpenStreetMap contributors · 건축물대장·정비사업').addTo(map);

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

const hiLayer = L.layerGroup().addTo(map);    // 검색으로 찾은 구역 강조 링
const markers = new Map();

const key = d => `${d.gu}|${d.dong}`;
const $ = s => document.querySelector(s);
const ico = n => `<svg class="ico" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const isMobile = () => window.matchMedia('(max-width:760px)').matches;
// 네이버 부동산 지도(좌표) 링크 — 해당 위치 매물 보기
const naverLink = (lat, lng) => `https://new.land.naver.com/houses?ms=${lat},${lng},16`;
const naverBtn = (lat, lng) =>
  `<a class="dbtn naver" href="${naverLink(lat, lng)}" target="_blank" rel="noopener">네이버 부동산 · 이 지역 매물 ${ico('external')}</a>`;
// 사업 상세(세대수·시공사·용적률) 네이버 검색 — 대량수집 불가 데이터라 검색으로 연결
const naverSearchBtn = (q) =>
  `<a class="dbtn" href="https://search.naver.com/search.naver?query=${encodeURIComponent(q + ' 재개발 세대수 시공사')}" target="_blank" rel="noopener">${ico('search')}세대수·용적률·시공사 검색</a>`;
// 구역명 검색 정규화 — '양평13' ↔ '양평제13구역'
const norm = s => (s || '').toLowerCase().replace(/\s+/g, '').replace(/제(?=\d)/g, '');
const stageIdx = p => STAGE_BUCKETS.findIndex(x => x.key === stageBucket(p.stage).key);
const steps5 = p => { const i = stageIdx(p);
  return `<span class="steps5" aria-label="5단계 중 ${i+1}단계">${STAGE_BUCKETS.map((b,j)=>`<i class="${j<=i?'on':''}" style="--c:${stageBucket(p.stage).color}"></i>`).join('')}</span>`; };

// ---------- load ----------
const noCache = { cache: 'no-store' };   // 데이터 갱신이 즉시 반영되도록 캐시 우회
Promise.all([
  fetch('./data/dongs.json', noCache).then(r => r.json()),
  fetch('./data/redev_points.json', noCache).then(r => r.json()).catch(() => []),
  fetch('./data/subway.json', noCache).then(r => r.json()).catch(() => null),
  fetch('./data/moa_zones.json', noCache).then(r => r.json()).catch(() => []),
  fetch('./data/curated_plans.json', noCache).then(r => r.json()).catch(() => []),
  fetch('./data/deals_by_dong.json', noCache).then(r => r.json()).catch(() => null),
]).then(([j, proj, sub, zones, plans, deals]) => {
  CURATED_PLANS = plans || [];
  state.deals = deals;
  state.stageFilter = new Set(STAGE_KEYS); state.methodFilter = new Set(METHOD_KEYS);
  state.all = j.dongs.filter(d => d.lat && d.lng);
  // 준공인가 = 이미 완공된 단지(예: 양평12구역→영등포자이디그니티) — '진행중 정비사업'에서 제외
  const isDone = p => /준공/.test(p.stage || '');
  state.projects = (proj || []).filter(p => p.lat && p.lng && !isDone(p));
  state.subway = sub;
  state.moaZones = zones || [];
  // 개발 프로젝트가 있는 (구|동) 집합 — 노후도 高·미개발 동에 별표 표시용
  state.projectDongs = new Set(state.projects.filter(isResi).map(p => `${p.gu}|${p.dong}`));
  $('#dataYear').textContent = j.year;
  $('#dongTotal').textContent = state.all.length;
  $('#projCount').textContent = state.projects.filter(isResi).length;
  $('#moaZoneN').textContent = state.moaZones.filter(z => z.n >= 2).length;
  $('#moaModeN').textContent = state.moaZones.length;
  // 데이터에 없는 정비상태(예: 경계 0건)는 버튼 숨김
  $('#verdictSeg').querySelectorAll('button[data-v]').forEach(b => {
    if (b.dataset.v !== 'all' && !state.all.some(d => d.verdict === b.dataset.v)) b.classList.add('hidden');
  });
  resetControls();
  initGuOptions(); renderLegend(); bindUI(); apply();
  renderSubway();   // 지하철 노선도 기본 표시
}).catch(e => { $('#list').innerHTML = `<li class="empty"><b>데이터를 불러오지 못했습니다</b><p>${e}</p><button onclick="location.reload()">${ico('reset')}새로고침</button></li>`; });

// 브라우저 폼 복원으로 인한 슬라이더/입력 잔존값 방지 — DOM을 기본값으로 강제
function resetControls(){
  $('#nohuRange').value = 70; $('#nohuVal').textContent = '70';
  $('#walkRange').value = 30; $('#walkVal').textContent = '전체';
  $('#farRange').value = 200; $('#farVal').textContent = '200%';
  $('#search').value = ''; $('#sortSel').value = 'score';
  $('#guSel').value = 'all'; $('#projToggle').checked = false;
  $('#moaZone').checked = false; $('#subwayToggle').checked = true;
  $('#moaModeBtn').classList.remove('active');
  Object.assign(state, { sort:'score', showProjects:false, projCat:'all', moaZone:false, showSubway:true, mode:'dong' });
  resetFilters(false);
}
// 탐색 필터만 기본값으로 (지도 레이어 설정은 유지)
function resetFilters(run = true){
  $('#nohuRange').value = 70; $('#nohuVal').textContent = '70';
  $('#walkRange').value = 30; $('#walkVal').textContent = '전체';
  $('#farRange').value = 200; $('#farVal').textContent = '200%';
  $('#search').value = ''; $('#guSel').value = 'all'; $('#resiOnly').checked = true;
  document.querySelectorAll('#gradeFilter input').forEach(i => i.checked = true);
  $('#verdictSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.v === 'all'));
  Object.assign(state, { verdict:'all', gu:'all', grades:new Set(['S','A','B','C','D']), nohu:70, walk:30, far:200, q:'', resiOnly:true });
  if (run) apply();
}
// 기본값과 다른 필터 목록 (빈 결과 원인 안내·필터 배지용)
function activeFilters(){
  const f = [];
  if (state.q) f.push(`검색 '${state.q}'`);
  if (state.verdict !== 'all') f.push(state.verdict);
  if (state.gu !== 'all') f.push(state.gu);
  if (state.grades.size < 5) f.push(`등급 ${[...state.grades].join('')}`);
  if (state.nohu !== 70) f.push(`노후도 ${state.nohu}%+`);
  if (state.walk < 30) f.push(`도보 ${state.walk}분 이내`);
  if (state.far !== 200) f.push(state.far >= 800 ? '용적률 전체' : `용적률 ${state.far}% 이하`);
  if (!state.resiOnly) f.push('도심상업 포함');
  return f;
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
    (state.far>=800 || d.est_far==null || d.est_far<=state.far) &&
    // 도심상업이라도 아파트 정비사업이 있는 동(문래·영등포·신설동 등 준공업·역세권)은 유지 — 명동·을지로 같은 업무지구만 제외
    (!state.resiOnly || d.subtype !== '도심상업' || state.projectDongs.has(key(d)))
  );
  // 검색: 동·구 + 정비사업 구역명(양평13 → 양평제13구역)
  state.projHits = [];
  const q = norm(state.q.trim());
  if (q){
    r = r.filter(d => norm(d.dong+d.gu).includes(q));
    if (q.length >= 2) state.projHits = state.projects.filter(p => isResi(p) && norm(p.name).includes(q)).slice(0, 8);
  }
  // 검색엔 맞는데 필터에 가려진 동 — 이름이 맞는 동 + 찾은 구역이 속한 동
  state.hiddenHits = [];
  if (q){
    const shown = new Set(r.map(key));
    const want = new Set(state.all.filter(d => norm(d.dong+d.gu).includes(q)).map(key));
    state.projHits.forEach(p => want.add(`${p.gu}|${p.dong}`));
    state.hiddenHits = state.all.filter(d => want.has(key(d)) && !shown.has(key(d)));
  }
  const af = activeFilters();
  $('#filterN').textContent = af.length ? af.length : '';
  $('#resetFilters').classList.toggle('hidden', !af.length);
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
  const g1 = state.grades.size===1 ? [...state.grades][0] : null;
  // 칩 = 바로가기 필터 (후보만 / 해당 등급만, 다시 누르면 해제)
  $('#summary').innerHTML =
    `<button class="chip ${state.verdict==='후보'?'on':''}" data-chip="cand" title="미지정 후보만 보기"><b style="color:var(--cand)">${cand}</b><span>미지정 후보</span></button>` +
    ['S','A','B','C'].map(g =>
      `<button class="chip ${g1===g?'on':''}" data-chip="${g}" title="${g}등급만 보기"><b class="g-${g}">${counts[g]}</b><span>${g}등급</span></button>`).join('');
}

function renderList(){
  $('#resultCount').textContent = `${state.filtered.length}개 동`;
  const hits = state.projHits || [];
  const projHtml = hits.length ? `<li class="lsec">정비사업 구역 ${hits.length}건</li>` + hits.map((p,i) => {
    const b = stageBucket(p.stage);
    return `<li><button class="item" data-p="${i}">
      <span class="ptag" style="background:${b.color}">${stageIdx(p)+1}/5</span>
      <span class="iname"><b>${shortName(p.name)}</b>
        <span class="meta">${p.gu} ${p.dong||''} · ${p.stage||'-'}</span>${steps5(p)}</span>
    </button></li>`;
  }).join('') + (state.filtered.length ? `<li class="lsec">동 ${state.filtered.length}곳</li>` : '') : '';
  const hid = state.hiddenHits || [];
  const hidHtml = hid.length ? `<li class="lsec">필터에 가려진 동 ${hid.length}곳 · 눌러서 보기</li>` + hid.map(d =>
    `<li><button class="item dim" data-k="${key(d)}">
      <span class="gbadge ${d.grade}">${d.grade}</span>
      <span class="iname"><b>${d.dong}</b><span class="meta">${d.gu} · 노후 ${fmt(d.nohu)}%</span>
        <span class="vtag vhid">${whyHidden(d)}</span></span>
      <span class="iscore"><b>${Math.round(d.score)}</b>점</span>
    </button></li>`).join('') : '';
  const html = state.filtered.slice(0,400).map(d => {
    const k = key(d);
    const walk = d.walk_min!=null ? ` · 역 ${d.walk_min}분` : '';
    return `<li><button class="item ${state.sel===k?'sel':''}" data-k="${k}">
      <span class="gbadge ${d.grade}" aria-label="${d.grade}등급">${d.grade}</span>
      <span class="iname"><b>${d.dong}</b>
        <span class="meta">${d.gu} · 노후 ${fmt(d.nohu)}%${walk}</span>
        <span class="vtag v${d.verdict}">${d.verdict}</span></span>
      <span class="iscore"><b>${Math.round(d.score)}</b>점</span>
    </button></li>`;
  }).join('');
  const ul = $('#list');
  const af = activeFilters();
  ul.innerHTML = (projHtml + hidHtml + html) || `<li class="empty"><b>조건에 맞는 동이 없습니다</b>
    <p>${af.length ? `적용 중: ${af.join(' · ')}` : '검색어나 필터를 바꿔 보세요'}</p>
    ${af.length ? `<button data-reset-filters>${ico('reset')}필터 초기화</button>` : ''}</li>`;
  ul.querySelectorAll('.item[data-k]').forEach(b => b.addEventListener('click', () => select(b.dataset.k, true)));
  ul.querySelectorAll('.item[data-p]').forEach(b => b.addEventListener('click', () => focusProject(hits[+b.dataset.p])));
  const rb = ul.querySelector('[data-reset-filters]'); rb && rb.addEventListener('click', () => resetFilters());
}
// 동이 어떤 필터에 걸려 빠졌는지 (첫 번째 이유)
function whyHidden(d){
  if (state.verdict!=='all' && d.verdict!==state.verdict) return `정비상태 ${d.verdict}`;
  if (state.gu!=='all' && d.gu!==state.gu) return `다른 구`;
  if (!state.grades.has(d.grade)) return `${d.grade}등급`;
  if ((d.nohu||0) < state.nohu) return `노후도 ${fmt(d.nohu)}% < ${state.nohu}%`;
  if (state.walk<30 && !(d.walk_min!=null && d.walk_min<=state.walk)) return `역 도보 ${d.walk_min??'—'}분`;
  if (state.far<800 && d.est_far!=null && d.est_far>state.far) return `용적률 ${fmt(d.est_far)}% > ${state.far}%`;
  if (state.resiOnly && d.subtype==='도심상업') return '도심상업지';
  return '필터';
}
// 조합 명칭 꼬리 정리 — '양평제13구역 도시환경정비사업조합' → '양평제13구역 도시환경정비'
const shortName = n => (n || '(이름없음)').replace(/\s*(사업)?\s*(조합설립추진위원회|추진위원회|조합)$/, '').replace(/사업$/, '');
// 검색 결과 구역으로 이동: 정비사업 레이어 켜고, 강조 링 + 상세
function focusProject(p){
  if (!p) return;
  if (!state.showProjects){ state.showProjects = true; $('#projToggle').checked = true; }
  if (state.colorBy==='stage') state.stageFilter = new Set(STAGE_KEYS); else state.methodFilter = new Set(METHOD_KEYS);
  if (state.projCat !== 'all' && catOf(p) !== state.projCat){
    state.projCat = 'all';
    $('#projCat').querySelectorAll('button').forEach(x=>x.classList.toggle('active', x.dataset.c==='all'));
  }
  renderProjects();
  hiLayer.clearLayers();
  L.circleMarker([p.lat, p.lng], { radius:15, color:'#17202d', weight:2, fill:false, dashArray:'3 3', interactive:false }).addTo(hiLayer);
  showZoneDetail(p);
  flyTo(p.lat, p.lng, 16);
}
// 상세 패널이 가리는 만큼 비켜서 중심 맞추기 (데스크톱: 왼쪽으로 패널 절반, 모바일: 지도 영역 그대로)
function flyTo(lat, lng, minZoom){
  const z = Math.max(map.getZoom(), minZoom);
  const detailOpen = !$('#detail').classList.contains('hidden');
  const dx = detailOpen && !isMobile() ? $('#detail').offsetWidth / 2 : 0;
  const c = map.unproject(map.project([lat, lng], z).add([dx, 0]), z);
  try { map.setView(c, z, { animate:true }); } catch(_){}
}

function renderMarkers(){
  layer.clearLayers(); markers.clear();
  state.filtered.forEach(d => {
    const k = key(d);
    const r = 5 + (d.score-30)/8;
    const sel = state.sel===k;
    const m = L.circleMarker([d.lat, d.lng], {
      radius: Math.max(5, r), color: sel ? '#0f172a' : (GCOL[d.grade]||'#666'),
      weight: sel ? 3.5 : 2.2,
      fillColor: GCOL[d.grade]||'#666', fillOpacity: sel ? .3 : .16,  // 라이트 테마 대비 강화
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
  $('#colorBy').classList.toggle('hidden', !on);
  const zoneable = on && state.projCat==='moa';
  $('#moaZoneWrap').classList.toggle('hidden', !zoneable);
  const resiTotal = state.projects.filter(isResi).length;
  if (!on){ $('#projCount').textContent = resiTotal; return; }
  const cat = state.projCat;
  const list = state.projects.filter(p => {
    const c = catOf(p); if (!c) return false;      // 비주거 제외
    if (!(cat === 'all' || c === cat)) return false;
    // 범례 필터 — 색상 기준 차원(단계/추진방식)으로 선택된 것만
    if (state.colorBy === 'stage' && state.stageFilter && !state.stageFilter.has(stageBucket(p.stage).key)) return false;
    if (state.colorBy === 'method' && state.methodFilter && !state.methodFilter.has(methodOf(p).key)) return false;
    return true;
  });
  $('#projCount').textContent = list.length;

  // 모아타운 카테고리: 개별 가로주택 구역 점 + 이를 묶는 모아타운 영역(원+라벨) 함께 표시
  if (zoneable && state.moaZone) renderMoaZones();

  const byMethod = state.colorBy === 'method';
  // 줌아웃 시 점을 작게 — 서울 전역 800여 점 겹침 완화
  const z = map.getZoom(), sc = z <= 11 ? .5 : z === 12 ? .7 : z === 13 ? .85 : 1;
  list.forEach(p => {
    const b = stageBucket(p.stage), moa = isMoa(p), m = methodOf(p);
    const fill = byMethod ? m.color : b.color;
    L.circleMarker([p.lat, p.lng], {
      radius: Math.max(3.5, (moa?9:8)*sc), color: moa?'#0e7490':'#fff', weight: moa?2:(sc<1?1:1.5),
      fillColor:fill, fillOpacity:.95,
    }).bindTooltip(`${shortName(p.name)}<br>${m.label} · ${p.stage||'-'}`, {direction:'top'})
      .on('click', () => showZoneDetail(p))
      .addTo(projLayer);
  });
  renderLegend();
}
// 범례 = 필터. 항목 클릭 시 그 단계/방식만 켜고/끄기. 제목(⟲) 클릭 = 전체 복원
const ALL_METHODS = [...METHODS, {key:'모아',label:'모아타운·소규모',color:'#0e7490'}, {key:'지주택',label:'지역주택조합',color:'#ca8a04'}, {key:'리모델링',label:'리모델링',color:'#94a3b8'}, {key:'민간',label:'민간정비',color:'#64748b'}];
function renderLegend(){
  const el = $('#stageLegend');
  const pool = state.projects.filter(p=>{const c=catOf(p);return c&&(state.projCat==='all'||c===state.projCat);});
  const cnt = {}; const kf = state.colorBy==='method' ? p=>methodOf(p).key : p=>stageBucket(p.stage).key;
  pool.forEach(p => { const k = kf(p); cnt[k] = (cnt[k]||0)+1; });
  const item = (dim, set, k, color, label) => { const on = !set || set.has(k);
    return `<button class="lgi ${on?'':'off'}" data-dim="${dim}" data-key="${k}" aria-pressed="${on}"><i style="background:${color}"></i>${label}<span class="n">${cnt[k]||0}</span></button>`; };
  const head = (dim, title) => `<div class="lthead"><span>${title} · 눌러서 골라보기</span><button class="lt" data-reset="${dim}">${ico('reset')}전체</button></div>`;
  if (state.colorBy === 'method'){
    el.innerHTML = head('method','추진방식') +
      ALL_METHODS.filter(m=>cnt[m.key]).map(m=>item('method', state.methodFilter, m.key, m.color, m.label)).join('');
  } else {
    el.innerHTML = head('stage','진행단계') +
      STAGE_BUCKETS.map((b,i)=>item('stage', state.stageFilter, b.key, b.color, `${i+1}. ${b.label}`)).join('') +
      `<span class="moa-key"><i></i>모아타운·소규모 (청록 테두리)</span>`;
  }
}

// 모아타운 = 인접 가로주택/소규모 구역 2개+ 묶음. 점선 원 + "동명 N구역" 라벨로 관리단위 표시
function renderMoaZones(){
  zoneLayer.clearLayers();
  state.moaZones.filter(z => z.n >= 2).forEach(z => {
    L.circle([z.lat, z.lng], { radius:z.r, color:'#0e7490', weight:1.5, dashArray:'5 4',
      fillColor:'#0e7490', fillOpacity:.08 })
      .on('click', () => showMoaZoneDetail(z))
      .addTo(zoneLayer);
    L.marker([z.lat, z.lng], { interactive:false, keyboard:false, icon: L.divIcon({ className:'',
      html:`<div class="moa-label">${z.dong} <b>${z.n}구역</b></div>`, iconSize:[0,0], iconAnchor:[0,0] })
    }).addTo(zoneLayer);
  });
}

function showMoaZoneDetail(z){
  $('#detailBody').innerHTML = `
    <div class="dbody">
      <div class="dhead">
        <div class="zbadge" style="width:44px;height:44px;font-size:18px;border-radius:10px">${z.n}</div>
        <div><h2>${z.dong} 모아타운</h2>
          <div class="dgu">${z.gu} · 소규모정비 <b style="color:var(--moa)">${z.n}구역</b> 묶음</div></div>
      </div>
      <div class="dproj">
        <div class="dproj-h">묶인 가로주택·소규모정비 구역</div>
        ${z.names.map(n=>`<div class="dproj-row"><span class="dproj-name">${shortName(n)}</span></div>`).join('')}
        ${z.n>z.names.length?`<div class="dproj-more">외 ${z.n-z.names.length}구역</div>`:''}
      </div>
      ${naverBtn(z.lat, z.lng)}
      <div class="disclaimer">모아타운(소규모주택정비 관리지역)은 인접한 가로주택정비·소규모재건축 구역을 묶어 함께 정비하는 단위입니다. 본 영역은 인접 사업 근접 클러스터링 추정치로, 서울시 공식 관리지역 경계와는 다를 수 있습니다.</div>
    </div>`;
  openDetail();
}

// ---------- 지하철 노선도 ----------
function renderSubway(){
  subwayLayer.clearLayers();
  if (!state.showSubway || !state.subway) return;
  const showNames = map.getZoom() >= SUBWAY_LABEL_ZOOM;
  const mobile = window.matchMedia('(max-width:760px)').matches;
  const lineW = mobile ? 2.25 : 4.5;     // 모바일은 선 굵기 절반
  const dotR = mobile ? 2 : 3;
  const seen = new Set();
  state.subway.lines.forEach(ln => {
    const pts = ln.stations.map(s => [s.lat, s.lng]);
    L.polyline(pts, { pane:'subwayPane', color:ln.color, weight:lineW, opacity:.95 }).addTo(subwayLayer);
    ln.stations.forEach(s => {
      L.circleMarker([s.lat, s.lng], { pane:'subwayPane', radius:dotR, color:'#fff', weight:1.2,
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
const CAT_LABEL = { recon:'재건축', redev:'재개발', moa:'모아타운·소규모' };
// 뉴스로 확정된 주요 구역의 재개발 '계획' (data/curated_plans.json, 이름 부분일치)
let CURATED_PLANS = [];
const curatedPlan = p => CURATED_PLANS.find(c => (p.name||'').includes(c.match));
function showZoneDetail(p){
  const b = stageBucket(p.stage), cat = catOf(p);
  const curIdx = STAGE_BUCKETS.findIndex(x => x.key === b.key);
  const steps = STAGE_BUCKETS.map((s,i) =>
    `<div class="zstep ${i<=curIdx?'done':''} ${i===curIdx?'cur':''}" style="--c:${b.color}"><i></i><span>${s.label.split('(')[0]}</span></div>`).join('');
  const m = methodOf(p);
  const plan = curatedPlan(p);
  const planHtml = plan ? `
    <div class="plan-spec">
      <div class="plan-h">재개발 계획${plan.brand?` · ${plan.brand}`:''} <span>뉴스 기준</span></div>
      <div class="cur-grid">
        ${plan.units?`<div><span>계획 세대수</span><b>${plan.units.toLocaleString()}세대</b></div>`:''}
        ${plan.floors?`<div><span>최고 층수</span><b>${plan.floors}층</b></div>`:''}
        ${plan.builder?`<div><span>시공사</span><b style="font-size:13px">${plan.builder}</b></div>`:''}
      </div>
      <div class="plan-note">${plan.src} · 조합·언론 발표 기준. 인허가 과정에서 변경될 수 있습니다.</div>
    </div>` : '';
  $('#detailBody').innerHTML = `
    <div class="dbody">
      <div class="dhead">
        <div class="ptag" style="background:${b.color}">${curIdx+1}/5</div>
        <div><h2 style="font-size:18px">${shortName(p.name)}</h2>
          <div class="dgu">${p.gu} ${p.dong||''} · ${CAT_LABEL[cat]||p.type}
            <span class="mtag"><i style="background:${m.color}"></i>${m.label}</span></div></div>
      </div>
      <div class="zstage">
        <span class="zstage-lbl">현재 진행 단계 · ${curIdx+1}/5</span>
        <span class="zstage-v">${p.stage||'-'}</span>
      </div>
      <div class="zsteps">${steps}</div>
      ${planHtml}
      ${dealsHtml(p.gu, p.dong)}
      <div class="dmetrics">
        <div class="metric"><div class="mk">사업 유형</div><div class="mv" style="font-size:14px">${p.type||'-'}</div></div>
        <div class="metric"><div class="mk">위치</div><div class="mv" style="font-size:14px">${p.gu} ${p.dong||''}</div></div>
      </div>
      ${state.all.some(d => d.gu===p.gu && d.dong===p.dong) ? `<button class="dbtn" id="toDong">${ico('pin')}${p.dong} 노후도·점수 보기</button>` : ''}
      ${naverSearchBtn(p.name || `${p.gu} ${p.dong}`)}
      ${naverBtn(p.lat, p.lng)}
      <div class="disclaimer">공식 명칭 · ${p.name||'-'}<br>세대수·용적률·시공사는 사업시행인가 이후 확정되며 일괄 데이터가 없어 검색으로 연결합니다. 진행단계는 서울 정비사업 정보몽땅 기준이며 최신 세부는 조합·자치구 고시를 확인하세요.</div>
    </div>`;
  openDetail();
  const td = $('#toDong'); td && td.addEventListener('click', () => select(`${p.gu}|${p.dong}`, false));
}

function openDetail(){
  $('#detail').classList.remove('hidden');
  document.body.classList.add('detail-open');
  $('#detail').scrollTop = 0;
}
function closeDetail(){
  $('#detail').classList.add('hidden');
  document.body.classList.remove('detail-open');
  gridLayer.clearLayers(); hiLayer.clearLayers();
  state.sel = null; renderList(); renderMarkers();
}

// ---------- selection / detail ----------
function select(k, fromList){
  state.sel = k;
  const d = state.all.find(x => key(x)===k);
  if (!d) return;
  gridLayer.clearLayers(); hiLayer.clearLayers();
  showDetail(d);
  renderList(); renderMarkers();
  if (fromList){
    const li = document.querySelector(`.item[data-k="${CSS.escape(k)}"]`);
    li && li.scrollIntoView({block:'nearest'});
  }
  if (fromList && Number.isFinite(d.lat) && Number.isFinite(d.lng)) flyTo(d.lat, d.lng, 15);
}

function bar(label, val, max, color){
  const pct = Math.max(0, Math.min(100, val/max*100));
  return `<div class="dbar"><div class="bl"><span>${label}</span><span>${fmt(val)}</span></div>
    <div class="bartrack"><div class="barfill" style="width:${pct}%;background:${color}"></div></div></div>`;
}

// ---------- 딥분석 (순위·백분위·강약점) ----------
function pctile(v, arr){ if (v==null) return null; let c=0; for (const x of arr) if (x<v) c++; return Math.round(c/arr.length*100); }
// 판정은 글자로, 막대 색은 중립(빨강은 등급 전용) — 상위 25%만 강조색
function pctTag(pct){ return pct>=75 ? ['우수','hi'] : pct>=45 ? ['보통','mid'] : ['미흡','lo']; }
function deepDiveHtml(d){
  const A = state.all;
  const guArr = A.filter(x=>x.gu===d.gu).map(x=>x.score);
  const rank = 1 + guArr.filter(s=>s>d.score).length;
  const pctScore = pctile(d.score, A.map(x=>x.score));
  const farOk = d.est_far!=null && d.est_far>=30;
  const rows = [
    ['노후도',        `${fmt(d.nohu)}%`,   pctile(d.nohu, A.map(x=>x.nohu))],
    ['저층 여력',     `${fmt(d.lowrise)}%`, pctile(d.lowrise, A.map(x=>x.lowrise))],
    ['역세권',        d.walk_min!=null?`${d.walk_min}분`:'—', d.walk_min!=null?pctile(-d.walk_min, A.filter(x=>x.walk_min!=null).map(x=>-x.walk_min)):null],
    ['저밀도(사업성)', farOk?`${fmt(d.est_far)}%`:'저밀', farOk?pctile(-d.est_far, A.filter(x=>x.est_far!=null&&x.est_far>=30).map(x=>-x.est_far)):null],
  ];
  return `<div class="deep">
    <div class="deep-h">서울 내 위치 · 백분위</div>
    <div class="deep-rank">
      <div><span>${d.gu} 내 순위</span><b>${rank}<small>위 / ${guArr.length}동</small></b></div>
      <div><span>서울 전체</span><b>상위 ${Math.max(1,100-pctScore)}%</b></div>
    </div>
    ${rows.map(([k,disp,pct]) => {
      if (pct==null) return `<div class="deep-m"><div class="dm-top"><span>${k}</span><span class="mut">${disp}</span></div></div>`;
      const [t,c] = pctTag(pct);
      return `<div class="deep-m"><div class="dm-top"><span>${k}<span class="dm-tag ${c}">${t}</span></span><span class="mut">${disp} · 상위 ${Math.max(1,100-pct)}%</span></div>
        <div class="dm-bar"><div class="dm-fill ${c==='hi'?'hi':''}" style="width:${pct}%"></div></div></div>`;
    }).join('')}
  </div>`;
}

// ---------- 동네 아파트 실거래 (국토부, 법정동 집계) ----------
function dealsFor(gu, dong){
  const g = state.deals && state.deals.gu[gu];
  if (!g) return null;
  if (g[dong]) return g[dong];
  const k = Object.keys(g).find(x => dong.startsWith(x) || x.startsWith(dong));
  return k ? g[k] : null;
}
function dealsHtml(gu, dong){
  const d = dealsFor(gu, dong);
  if (!d || !d.n) return '';
  return `<div class="deals">
    <div class="deals-h">${dong} 아파트 실거래 <span>최근 3개월 · ${d.n}건</span></div>
    <div class="cur-grid">
      ${d.p84?`<div><span>84㎡급 중앙</span><b>${d.p84}억</b></div>`:''}
      <div><span>전체 중앙값</span><b>${d.med}억</b></div>
      <div><span>거래 범위</span><b style="font-size:13px">${d.min}~${d.max}억</b></div>
    </div>
    <div class="deals-note">국토부 실거래가 ${state.deals.updated} 기준 · <b>동네 아파트 전체</b> 참고치(재개발 구역 자체 거래 아님). 정확한 매물·시세는 아래 링크로 확인.</div>
  </div>`;
}

// ---------- 비교분석 (여러 동 담아 표+레이더) ----------
function addToCompare(k){
  if (state.compare.includes(k)) { renderCompareBar('이미 담김'); return; }
  if (state.compare.length >= 4) { renderCompareBar('최대 4개'); return; }
  state.compare.push(k); renderCompareBar();
}
function renderCompareBar(msg){
  const b = $('#compareBar');
  b.classList.toggle('hidden', state.compare.length===0);
  $('#cmpCount').textContent = msg || `비교 ${state.compare.length}/4`;
  if (msg) setTimeout(() => renderCompareBar(), 1400);
}
function compareTable(ds){
  const rows = [
    ['종합점수', d=>Math.round(d.score), true],
    ['등급',     d=>`<b class="g-${d.grade}">${d.grade}</b>`],
    ['노후도',   d=>fmt(d.nohu)+'%', true],
    ['저층비율', d=>fmt(d.lowrise)+'%', true],
    ['평균연식', d=>fmt(d.avg_age)+'년', true],
    ['추정용적률', d=>(d.est_far!=null&&d.est_far>=30)?fmt(d.est_far)+'%':'저밀'],
    ['역세권',   d=>d.walk_min!=null?d.walk_min+'분':'—'],
    ['정비상태', d=>`<span class="vtag v${d.verdict}">${d.verdict}</span>`],
  ];
  return `<table class="cmp-tbl"><thead><tr><th></th>${ds.map(d=>`<th>${d.dong}<small>${d.gu}</small></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([k,fn,hi])=>{
      let best=-Infinity; if(hi) ds.forEach(d=>{const v=parseFloat(fn(d)); if(v>best)best=v;});
      return `<tr><td class="ck">${k}</td>${ds.map(d=>{const raw=fn(d); const v=parseFloat(raw); const top=hi&&v===best&&ds.length>1;
        return `<td class="${top?'best':''}">${raw}</td>`;}).join('')}</tr>`;
    }).join('')}</tbody></table>`;
}
function compareRadar(ds){
  const axes = [
    ['노후도', d=>d.nohu||0], ['저층', d=>d.lowrise||0],
    ['역세권', d=>d.walk_min!=null?Math.max(0,(30-d.walk_min)/30*100):0],
    ['저밀', d=>(d.est_far!=null&&d.est_far>=30)?Math.max(0,(400-Math.min(d.est_far,400))/400*100):50],
    ['점수', d=>d.score||0],
  ];
  const CL=['#2563eb','#ea580c','#0e7490','#7c3aed'], cx=140,cy=145,R=100,n=axes.length;
  const pt=(i,r)=>[(cx+r*Math.sin(i/n*2*Math.PI)).toFixed(1),(cy-r*Math.cos(i/n*2*Math.PI)).toFixed(1)];
  let s=`<svg viewBox="0 0 280 300" class="cmp-radar">`;
  for(let g=1;g<=4;g++){ s+=`<polygon points="${axes.map((_,i)=>pt(i,R*g/4).join(',')).join(' ')}" fill="none" stroke="var(--line)"/>`; }
  axes.forEach((a,i)=>{ const[x,y]=pt(i,R); s+=`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--line)"/>`;
    const[lx,ly]=pt(i,R+18); s+=`<text x="${lx}" y="${ly}" font-size="11" fill="var(--mut)" text-anchor="middle" dominant-baseline="middle">${a[0]}</text>`; });
  ds.forEach((d,di)=>{ const c=CL[di];
    s+=`<polygon points="${axes.map((a,i)=>pt(i,R*Math.min(100,a[1](d))/100).join(',')).join(' ')}" fill="${c}33" stroke="${c}" stroke-width="2"/>`; });
  s+=`</svg>`;
  return `<div class="cmp-radar-wrap">${s}<div class="cmp-leg">${ds.map((d,i)=>`<span><i style="background:${CL[i]}"></i>${d.dong}</span>`).join('')}</div></div>`;
}
function openCompare(){
  const ds = state.compare.map(k=>state.all.find(x=>key(x)===k)).filter(Boolean);
  if(!ds.length) return;
  $('#cmpBody').innerHTML = `<h2>동 비교</h2><div class="dsub">${ds.length}개 동 · 굵은 칸이 항목별 최고값</div>` +
    compareRadar(ds) + compareTable(ds);
  openModal('#compareModal');
}
// 모달 열기/닫기 — 포커스를 닫기 버튼으로, 닫으면 원래 자리로
let lastFocus = null;
function openModal(sel){
  lastFocus = document.activeElement;
  $(sel).classList.remove('hidden');
  const c = $(sel).querySelector('.dclose'); c && c.focus();
}
function closeModal(sel){
  if ($(sel).classList.contains('hidden')) return false;
  $(sel).classList.add('hidden');
  lastFocus && lastFocus.focus && lastFocus.focus();
  return true;
}

function showDetail(d){
  const gridKey = `${d.sgg}_${d.bjd}`;
  const hasGrid = PINSET_AVAILABLE.has(gridKey);
  const walk = d.walk_min!=null ? `${d.walk_min}분 <small>(${d.station_dist}m)</small>` : '—';
  // 추정 용적률: 대지면적 누락으로 30% 미만·미상은 신뢰불가 → 저밀 표기
  const far  = (d.est_far!=null && d.est_far>=30) ? `${fmt(d.est_far)}%`
             : `<span style="color:var(--mut);font-size:13px">저밀 <small>(추정한계)</small></span>`;
  const slope= d.avg_slope!=null ? `${fmt(d.avg_slope)}°` : '—';
  const note = d.note ? `<div class="dnote"><b>비고</b> · ${d.note}</div>` : '';
  // 이 동의 진행중 정비사업 + 진행단계 (동 상세에서 바로 확인)
  const dongProj = state.projects.filter(p => isResi(p) && p.gu===d.gu && p.dong===d.dong)
    .sort((a,b)=> stageIdx(b) - stageIdx(a));
  const projHtml = dongProj.length
    ? `<div class="dproj"><div class="dproj-h">이 동의 진행중 정비사업 · ${dongProj.length}건</div>` +
      dongProj.slice(0,8).map((p,i)=>{ const b=stageBucket(p.stage);
        return `<button class="dproj-row" data-dp="${i}"><span class="dproj-stage" style="background:${b.color}">${p.stage||'-'}</span><span class="dproj-name">${shortName(p.name)}</span></button>`;
      }).join('') + (dongProj.length>8?`<div class="dproj-more">외 ${dongProj.length-8}건</div>`:'') + `</div>`
    : ((d.nohu||0)>=70 ? `<div class="dproj none">★ 진행중 정비사업 없음 — <b>미지정 발굴 후보</b></div>` : '');
  $('#detailBody').innerHTML = `
    <div class="dbody">
      <div class="dhead">
        <div class="gbadge ${d.grade}">${d.grade}</div>
        <div><h2>${d.dong}</h2><div class="dgu">${d.gu} · ${d.subtype} · <span class="vtag v${d.verdict}">${d.verdict}</span></div></div>
      </div>
      <div class="dscore"><span class="big">${Math.round(d.score)}</span><span class="lbl">/ 100 종합 재개발 점수</span></div>
      ${projHtml}
      ${bar('노후도 (30년+ 비율)', d.nohu, 100, GCOL[d.grade])}
      ${bar('저층 비율 (1~3층)', d.lowrise, 100, '#22c55e')}
      <div class="dmetrics">
        <div class="metric"><div class="mk">평균 연식</div><div class="mv">${fmt(d.avg_age)}<small> 년</small></div></div>
        <div class="metric"><div class="mk">평균 층수</div><div class="mv">${fmt(d.avg_floor)}<small> 층</small></div></div>
        <div class="metric"><div class="mk">추정 용적률</div><div class="mv">${far}</div></div>
        <div class="metric"><div class="mk">역세권 도보</div><div class="mv">${walk}</div></div>
        <div class="metric"><div class="mk">건물 수</div><div class="mv">${d.buildings}<small>동${d.sampled?` · 표본 ${d.sampled}중 ${d.old} 노후` : ` · ${d.old} 노후`}</small></div></div>
        <div class="metric"><div class="mk">평균 경사</div><div class="mv">${slope}</div></div>
      </div>
      ${dealsHtml(d.gu, d.dong)}
      ${deepDiveHtml(d)}
      ${note}
      <button class="dbtn primary" id="cmpAddBtn">${ico('scale')}${state.compare.includes(key(d))?'비교에 담김':'비교에 담기'}</button>
      ${naverBtn(d.lat, d.lng)}
      ${hasGrid ? `<button class="dbtn" id="gridBtn">${ico('grid')}블록정밀 격자 보기 (100m)</button>` : ''}
      ${simHtml(d)}
      <div class="disclaimer">
        ※ 건축물대장(국토부) 표본 기반 추정치. 종합점수 = 노후도·사업성(저층·용적·역세권)·연식·용도 가중합.
        실제 정비사업 지정·진행은 자치구·서울시 고시를 별도 확인하세요. 투자 판단 책임은 본인에게 있습니다.
      </div>
    </div>`;
  openDetail();
  if (hasGrid) $('#gridBtn').addEventListener('click', () => loadGrid(gridKey, d));
  $('#cmpAddBtn').addEventListener('click', e => { addToCompare(key(d));
    if (state.compare.includes(key(d))) e.currentTarget.innerHTML = `${ico('scale')}비교에 담김`; });
  $('#detailBody').querySelectorAll('[data-dp]').forEach(b => b.addEventListener('click', () => focusProject(dongProj[+b.dataset.dp])));
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
  const btn = $('#gridBtn'); btn.textContent = '격자 불러오는 중…';
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
    btn.textContent = `블록정밀 ${cells.length}격자 표시 중 (노후율 색상)`;
  }).catch(() => { btn.textContent = '격자를 불러오지 못했습니다 — 다시 누르기'; });
}

// ---------- 투자 시뮬 (추정 분담금) ----------
// 시뮬 기본값 — 이 동 84㎡ 실거래(공급 약 34평)로 신축 평당가를 잡고, 조합원가는 그 70%로 가정
function simDefaults(d){
  const dl = dealsFor(d.gu, d.dong);
  const base = dl && (dl.p84 || dl.med);
  if (!base) return { buy:6, right:4.5, unit:25, jp:3600, mp:5000, src:null };
  const mp = Math.round(base*10000/34/100)*100;
  return { buy:6, right:4.5, unit:25, jp:Math.round(mp*.7/100)*100, mp,
    src:`${d.dong} 아파트 ${dl.p84?'84㎡급':'전체'} 중앙 <b>${base}억</b> → 신축 평당 ${mp.toLocaleString()}만원 가정` };
}
function simHtml(d){
  const s = simDefaults(d);
  return `
  <div class="sim" id="sim">
    <button class="sim-head" id="simHead" aria-expanded="false">투자 시뮬 · 추정 분담금<small>예시값</small><svg class="ico chev"><use href="#i-chev"/></svg></button>
    <div class="sim-body">
      <div class="sim-src">${s.src ? `예시값: ${s.src}. 매입가·권리가액은 본인 조건으로 고쳐 넣으세요.` : '이 동은 실거래 표본이 없어 <b>일반 예시값</b>입니다. 본인 조건으로 고쳐 넣으세요.'}</div>
      <div class="sim-in"><label for="s_buy">매입가 (실투입 원가, 억원)</label><input type="number" id="s_buy" value="${s.buy}" min="0" step="0.5"></div>
      <div class="sim-in"><label for="s_right">권리가액 (감정평가, 억원)</label><input type="number" id="s_right" value="${s.right}" min="0" step="0.5"></div>
      <div class="sim-in"><label for="s_unit">분양받을 평형 (평)</label><input type="number" id="s_unit" value="${s.unit}" min="1"></div>
      <div class="sim-in"><label for="s_jprice">조합원 분양가 (만원/평)</label><input type="number" id="s_jprice" value="${s.jp}" min="0" step="100"></div>
      <div class="sim-in"><label for="s_mprice">신축 예상시세 (만원/평)</label><input type="number" id="s_mprice" value="${s.mp}" min="0" step="100"></div>
      <div class="sim-out" id="simOut"></div>
      <div class="sim-note">단순 교육용 추정. 사업비·이주비·금융비·취득세·사업기간(보통 10년+)·미동의 리스크는 반영하지 않습니다.
        분담금=조합원분양가−권리가액, 총투입=매입가+분담금, 차익=신축시세−총투입.</div>
    </div>
  </div>`;
}
function bindSim(d){
  const sim = $('#sim');
  $('#simHead').addEventListener('click', e => { const o = sim.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); });
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

$('#detailClose').addEventListener('click', closeDetail);
$('#detailClose2').addEventListener('click', closeDetail);

// ---------- 모아타운 구역 조회 모드 ----------
function enterMoaMode(){
  if (state.mode !== 'moa')   // 진입 전 지도 상태 저장 → 나갈 때 복원
    state._prevProj = { showProjects: state.showProjects, projCat: state.projCat, moaZone: state.moaZone };
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
  // 진입 전 상태로 복원 (모아 조회 켜기 전이 기본이면 정비사업 레이어도 꺼짐)
  const prev = state._prevProj || { showProjects:false, projCat:'all', moaZone:false };
  state.showProjects = prev.showProjects; $('#projToggle').checked = prev.showProjects;
  state.projCat = prev.projCat;
  $('#projCat').querySelectorAll('button').forEach(x=>x.classList.toggle('active', x.dataset.c===prev.projCat));
  state.moaZone = prev.moaZone; $('#moaZone').checked = prev.moaZone;
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
    `<div class="chip"><b style="color:var(--moa)">${zones.length}</b><span>모아 구역</span></div>` +
    `<div class="chip"><b>${zones.filter(z=>z.n>=2).length}</b><span>다중사업</span></div>` +
    `<div class="chip"><b>${total}</b><span>소규모정비</span></div>` +
    `<div class="chip"><b>${new Set(zones.map(z=>z.gu)).size}</b><span>자치구</span></div>`;
  const ul = $('#list');
  ul.innerHTML = zones.map((z,i) => `<li><button class="item" data-z="${i}">
      <span class="zbadge">${z.n}</span>
      <span class="iname"><b>${z.dong} 일대</b>
        <span class="meta">${z.gu} · ${z.stage||'-'}</span>
        <span class="meta">${shortName(z.names[0])}${z.n>1?` 외 ${z.n-1}곳`:''}</span></span>
    </button></li>`).join('') || `<li class="empty"><b>조건에 맞는 구역이 없습니다</b><p>자치구·검색어를 바꿔 보세요</p></li>`;
  ul.querySelectorAll('.item').forEach(li => li.addEventListener('click', () => {
    const z = zones[+li.dataset.z];
    showMoaZoneDetail(z);
    flyTo(z.lat, z.lng, 16);
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
    <h2>서울 재개발 통계</h2>
    <div class="dsub">건축물대장 ${$('#dataYear').textContent} · ${all.length}개 동 · 주거단지 재개발·재건축 ${proj.length}곳(추진중) · 평균 노후도 ${avgNohu.toFixed(0)}%</div>
    <div class="dstat">
      <div class="box"><b style="color:var(--cand)">${cand.length}</b><span>미지정 후보 동</span></div>
      <div class="box"><b>${catCnt.recon}</b><span>재건축</span></div>
      <div class="box"><b>${catCnt.redev}</b><span>재개발</span></div>
      <div class="box"><b>${catCnt.moa}</b><span>모아타운·소규모</span></div>
    </div>
    <div class="dsection">
      <h3>자치구별 미지정 후보 동 (상위 ${Math.min(guRank.length,15)})</h3>
      ${guRank.slice(0,15).map(g=>`<div class="gbar">
        <span class="gn">${g.gu}</span>
        <span class="gt"><span class="gf" style="width:${g.n/maxGu*100}%;background:var(--acc)"></span></span>
        <span class="gv">${g.n}개 · 노후${g.nohu.toFixed(0)}%</span></div>`).join('')}
    </div>
    <div class="dsection">
      <h3>종합점수 등급 분포 (전체 ${all.length}동)</h3>
      ${['S','A','B','C','D'].map(g=>`<div class="gbar">
        <span class="gn g-${g}" style="font-weight:700">${g}등급</span>
        <span class="gt"><span class="gf" style="width:${gradeCnt[g]/maxGrade*100}%;background:${GCOL[g]}"></span></span>
        <span class="gv">${gradeCnt[g]}동</span></div>`).join('')}
    </div>
    <div class="dsection">
      <h3>실제 정비사업 진행단계 (${proj.length}곳)</h3>
      ${STAGE_BUCKETS.map((b,i)=>{const s=stageCnt[b.key];return `<div class="gbar">
        <span class="gn wide">${i+1}. ${b.label}</span>
        <span class="gt"><span class="gf" style="width:${s.n/maxStage*100}%;background:${b.color}"></span></span>
        <span class="gv">${s.n}곳</span></div>`}).join('')}
    </div>
    <div class="dsection">
      <h3>자치구별 모아타운·소규모주택정비 (${moa.length}곳, 상위 ${Math.min(moaRank.length,15)})</h3>
      ${moaRank.slice(0,15).map(m=>`<div class="gbar">
        <span class="gn">${m.gu}</span>
        <span class="gt"><span class="gf" style="width:${m.n/maxMoa*100}%;background:var(--moa)"></span></span>
        <span class="gv">${m.n}곳</span></div>`).join('')}
    </div>`;
  openModal('#dash');
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
  $('#resiOnly').addEventListener('change', e => { state.resiOnly=e.target.checked; apply(); });
  $('#resetFilters').addEventListener('click', () => resetFilters());
  // 요약 칩 = 바로가기 (다시 누르면 해제)
  $('#summary').addEventListener('click', e => {
    const c = e.target.closest('[data-chip]'); if (!c || state.mode==='moa') return;
    const v = c.dataset.chip;
    if (v === 'cand'){
      state.verdict = state.verdict==='후보' ? 'all' : '후보';
      $('#verdictSeg').querySelectorAll('button').forEach(x=>x.classList.toggle('active', x.dataset.v===state.verdict));
    } else {
      const only = state.grades.size===1 && state.grades.has(v);
      state.grades = only ? new Set(['S','A','B','C','D']) : new Set([v]);
      document.querySelectorAll('#gradeFilter input').forEach(i => i.checked = state.grades.has(i.value));
    }
    apply();
  });
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
    if (b.dataset.c==='moa'){ state.moaZone=true; $('#moaZone').checked=true; }   // 묶음 자동 표시
    if (b.dataset.c!=='moa' && state.mode==='moa'){ exitMoaMode(); apply(); }
    renderProjects();
  });
  $('#moaZone').addEventListener('change', e => { state.moaZone=e.target.checked; renderProjects(); });
  $('#subwayToggle').addEventListener('change', e => { state.showSubway=e.target.checked; renderSubway(); });
  $('#colorBy').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#colorBy').querySelectorAll('button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); state.colorBy=b.dataset.cb; renderProjects();
  });
  // 범례 클릭 = 단계/방식 필터
  $('#stageLegend').addEventListener('click', e => {
    const reset = e.target.closest('[data-reset]');
    if (reset){ if (reset.dataset.reset==='stage') state.stageFilter=new Set(STAGE_KEYS); else state.methodFilter=new Set(METHOD_KEYS); renderProjects(); return; }
    const item = e.target.closest('.lgi'); if (!item) return;
    const set = item.dataset.dim==='stage' ? state.stageFilter : state.methodFilter;
    const k = item.dataset.key;
    set.has(k) ? set.delete(k) : set.add(k);
    if (set.size===0) (item.dataset.dim==='stage'?STAGE_KEYS:METHOD_KEYS).forEach(x=>set.add(x)); // 전부 끄면 전체 복원
    renderProjects();
  });
  // 스플래시 — '다시 보지 않기' (저장소 막힌 환경에서도 동작하도록 try/catch)
  const SKIP_KEY = 'redev-radar:skip-splash';
  const closeSplash = () => {
    $('#splash').classList.add('hide');
    if ($('#splashSkip').checked) { try { localStorage.setItem(SKIP_KEY, '1'); } catch(_){} }
  };
  let skip = false; try { skip = localStorage.getItem(SKIP_KEY) === '1'; } catch(_){}
  if (skip) $('#splash').classList.add('hide'); else $('#splashStart').focus();
  $('#splashStart').addEventListener('click', closeSplash);
  $('#splash').addEventListener('click', e => { if (e.target.id==='splash') closeSplash(); });

  // 모바일: 필터는 접고(목록 먼저), 지도 컨트롤은 필터 상자 안으로. 데스크톱은 항상 펼침 + 지도 위
  const mq = window.matchMedia('(max-width:760px)');
  const mc = $('#mapControls'), mapWrapEl = $('#mapWrap'), fbody = document.querySelector('#filterBox .filters');
  const placeControls = () => {
    if (mq.matches){ if (mc.parentElement !== fbody) fbody.appendChild(mc); $('#filterBox').open = false; }
    else { if (mc.parentElement !== mapWrapEl) mapWrapEl.insertBefore(mc, $('#gradeLegend')); $('#filterBox').open = true; }
  };
  placeControls();
  mq.addEventListener('change', () => { placeControls(); if (state.showSubway) renderSubway(); });
  $('#filterBox').addEventListener('toggle', () => { if (!mq.matches && !$('#filterBox').open) $('#filterBox').open = true; });
  $('#dashBtn').addEventListener('click', openDash);
  $('#dashClose').addEventListener('click', () => closeModal('#dash'));
  $('#cmpOpen').addEventListener('click', openCompare);
  $('#cmpClear').addEventListener('click', () => { state.compare=[]; renderCompareBar(); });
  $('#cmpClose').addEventListener('click', () => closeModal('#compareModal'));
  $('#compareModal').addEventListener('click', e => { if (e.target.id==='compareModal') closeModal('#compareModal'); });
  $('#dash').addEventListener('click', e => { if (e.target.id==='dash') closeModal('#dash'); });
  // Esc = 가장 위 레이어부터 닫기 (스플래시 → 모달 → 상세)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#splash').classList.contains('hide')) return closeSplash();
    if (closeModal('#compareModal') || closeModal('#dash')) return;
    if (!$('#detail').classList.contains('hidden')) closeDetail();
  });
  // 줌에 따라 정비사업 점 크기 갱신
  map.on('zoomend', () => { if (state.showProjects) renderProjects(); });
}

function fmt(v){ return v==null ? '—' : (Math.round(v*10)/10).toLocaleString(); }
