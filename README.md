# 📡 재개발 레이더 (Redev Radar)

서울 25개 구 **377개 행정동**의 건축물대장 기반 재개발 후보를 지도에서 탐색하는 정적 웹앱.
백엔드 없음 — `data/dongs.json` 한 파일만 읽는 순수 프론트엔드.

## 기능
- **지도** (Leaflet, 다크) — 동별 종합점수 등급(S/A/B/C/D) 색상 마커, 점수=크기
- **랭킹 리스트** — 종합점수·노후도·역세권·사업성순 정렬
- **필터** — 정비상태(🎯미지정 후보/진행중/경계), 자치구, 등급, 노후도, 역세권 도보거리, **추정용적률 상한(고밀 제외)**, 검색
- **상세패널** — 노후도·저층비율 바, 평균연식·층수·추정용적률·역세권·건물수·경사 + 비고
- **🏗️ 실제 정비사업 레이어** — 진행중 정비사업 814곳을 5단계(초기→조합설립→사업시행→관리처분→착공/준공) 색상으로 지도 오버레이. **🏘️ 모아타운/일반 분류 필터**(소규모주택정비 198곳은 청록 테두리로 구분: 가로주택정비·소규모재건축·소규모재개발)
- **🔬 블록정밀 격자** — 동 안을 100m 격자로 나눈 노후율 히트맵 (캐시된 동만: 남영동·문래동4가, 그 외는 백엔드 필요)
- **🏘️ 모아타운 구역 조회** — 사이드바 "모아타운 구역 조회" 버튼 → 116개 추정구역을 리스트로 조회(개수·동·대표사업), 클릭 시 지도 이동+구성 사업 팝업. 지도도 자동으로 모아 구역 레이어로 전환. 구·검색 필터 연동. 근접(≤350m) 소규모정비 사업 클러스터링(다중사업 구역 34개). ⚠️공식 관리지역 경계 아님(서울 열린데이터에 폴리곤 공개 API 없음) — 근접 사업 묶음 근사치
- **🚇 지하철 노선도** — 12개 노선(370역) 공식 노선색 폴리라인 오버레이 + 역 표시. 역세권 재개발 입지 판단용
- **💰 투자 시뮬** — 매입가·권리가액·분양평형으로 추정 분담금·총투입·예상차익·수익률 계산
- **📊 통계 대시보드** — 자치구별 후보 랭킹, 등급 분포, 정비사업 단계 분포, 자치구별 모아타운 집계
- 리스트 ↔ 지도 실시간 동기화

## 데이터 (`data/`)
- `dongs.json` — 377개 동, building_age.json에서 추출 (+ sgg/bjd 코드)
- `redev_points.json` — 실제 정비사업 814곳 (조합명·유형·단계·좌표)
- `pinset/{sgg}_{bjd}.json` — 블록정밀 격자 (현재 11170_10500 남영동, 11560_12200 문래동4가)
- `subway.json` — 12개 노선 370역 (노선별 순서·공식색), seoul-realestate/backend/data/subway_stations.py에서 추출
- `moa_zones.json` — 모아타운 추정구역 116개 (소규모정비 사업 350m 클러스터링, redev_points.json에서 생성)

종합점수 = 노후도 + 사업성(저층·용적·역세권) + 연식 + 용도 가중합.
※ 표본 추정치이며, 실제 정비사업 지정·진행 여부는 자치구·서울시 고시를 별도 확인.
블록정밀 격자를 다른 동까지 확장하려면 seoul-realestate 백엔드(`/api/pinset`, PUBLIC_DATA_KEY+KAKAO_REST_KEY)로 사전계산 후 `data/pinset/`에 넣고 app.js의 `PINSET_AVAILABLE`에 키 추가.

## 실행
```bash
cd redev-radar
python -m http.server 5180
# http://localhost:5180
```
정적 호스트(Vercel 등)에 폴더 그대로 배포 가능.

## 정비사업 데이터 갱신 (권위 원본)
정비사업 점/모아타운 구역의 **진행단계·주소**는 서울 정보몽땅 '사업장목록.xls'가 권위 원본.
아래 한 방이면 정보몽땅에서 최신본을 직접 내려받아 redev_points.json + moa_zones.json 전체 재생성:
```bash
cd seoul-realestate/backend
python scripts/refresh_redev_from_cleanup.py
```
(기존 좌표 재활용 + 신규만 Kakao 지오코딩. 결과를 redev-radar/data 에도 자동 반영.)
⚠️ 정보몽땅 OpenAPI(CleanupBussinessProgress)엔 주소가 없어 못 씀. 열린데이터 자동 API가 아니라
정보몽땅 통계 페이지 엑셀 엔드포인트(lsubBsnsSttusExcel.do)를 직접 호출. 예정 단계는 반영 안 됨(완료 단계만).
데이터 갱신 후 브라우저에 즉시 반영되도록 데이터 fetch는 `cache:'no-store'`, JS/CSS는 `?v=` 버전쿼리 사용.

## 노후도(dongs.json) 갱신
`seoul-realestate`의 building_age.json이 갱신되면:
```bash
python - <<'PY'
import json
d=json.load(open(r'C:/Users/qkrwj/seoul-realestate/backend/data/building_age.json',encoding='utf-8'))
keep=['gu','dong','nohu','avg_age','avg_floor','lowrise','est_far','kind','already_zone','verdict','lat','lng','score','grade','subtype','note','station_dist','walk_min','avg_slope','biz_room','buildings','old']
dongs=[x for x in d['dongs'] if x.get('lat') and x.get('lng')]
json.dump({'year':d['year'],'dongs':[{k:x.get(k) for k in keep} for x in dongs]},
          open(r'C:/Users/qkrwj/redev-radar/data/dongs.json','w',encoding='utf-8'),ensure_ascii=False)
PY
```
