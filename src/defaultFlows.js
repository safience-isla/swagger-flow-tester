// 기본 제공 플로우 (컴팩트 포맷). 앱 첫 로드 시 저장된 플로우에 자동 시드되고,
// 가져오기 모달의 '기본 플로우' 프리셋 버튼으로도 불러올 수 있다.
//   save : 이 스텝 응답값을 변수로 저장  ($.row._id → 응답은 ObjectResponse 로 {row} 래핑됨)
//   bind : 이전 스텝 변수값을 이 스텝 파라미터에 자동 연결
//
// 소셜 가입/로그인/연동/탈퇴/해제는 서버가 OAuth redirect-callback 을 소유하므로 플로우로
// 자동화 불가 → 좌측 '소셜 로그인' 탭(SocialLoginPage)에서 실 OAuth 로 테스트한다.
export const DEFAULT_FLOWS = [
  {
    // 인증 필요 → '소셜 로그인' 탭에서 로그인해 accessToken 확보 후 전역 Authorization 세팅.
    label: '장바구니',
    data: {
      name: '장바구니 (로그인 후)',
      flow: [
        // 상품 목록 → 판매중(ON_SALE) 첫 상품의 _id 를 productId 로 저장 (배열 필터 바인딩)
        { api: '고객 상품 목록 조회', save: { productId: '$.rows[saleStatus=ON_SALE]._id' } },
        // 담기 → 응답 row.cartItemId 를 저장 (이후 수량변경/삭제에 사용)
        {
          api: '장바구니 담기',
          bind: { productId: '{{productId}}' },
          values: { quantity: 1 },
          save: { cartItemId: '$.row.cartItemId' },
        },
        { api: '장바구니 조회' },
        { api: '장바구니 수량 변경', bind: { cartItemId: '{{cartItemId}}' }, values: { quantity: 2 } },
        { api: '장바구니 개별 삭제', bind: { cartItemId: '{{cartItemId}}' } },
      ],
    },
  },

  // ── 회원번호(memberNo) 키 공유 테스트 ─────────────────────────────────────────
  // 공유는 '공유자 A'가 만들고 '수신자 B'가 수락하는 2인 시나리오다. 전역 Authorization 은
  // 소셜 로그인 1개뿐이라 한 플로우에 두 계정을 담을 수 없어 2개로 나눈다:
  //   1) 공유자 A 로그인 → '회원번호 공유 — 공유자(생성)' 실행
  //   2) 수신자 B 로그인 → '회원번호 공유 — 수신자(수락)' 실행
  {
    label: '회원번호 공유 — 공유자(생성)',
    data: {
      name: '회원번호 공유 — 공유자(생성)',
      flow: [
        // 공유자 A(차량 소유자)로 로그인한 상태에서 실행.
        // shareType/isRequireAccept 는 고정, carId 는 필수라 실행 시 입력창이 뜬다
        // → 그 창에서 carId·keyId·memberNo(수신자 회원번호)를 함께 입력한다.
        {
          api: '디지털 키 공유 생성',
          values: { shareType: 'MEMBER_NO', isRequireAccept: true, isRequireApproval: false },
        },
        // 생성 확인 — 내가 공유한 목록에 방금 건이 WAITING_ACCEPT 로 떠야 함
        { api: '내가 공유한 키 공유 목록 조회' },
      ],
    },
  },
  {
    label: '회원번호 공유 — 수신자(수락)',
    data: {
      name: '회원번호 공유 — 수신자(수락)',
      flow: [
        // 수신자 B로 로그인한 상태에서 실행.
        // 받은 목록에서 수락 대기(WAITING_ACCEPT) 건의 keyShareId 를 뽑아 (배열 필터 바인딩)
        { api: '내가 받은 키 공유 목록 조회', save: { keyShareId: '$.row[status=WAITING_ACCEPT]._id' } },
        // 그 keyShareId 로 수락 → SHARED 로 전환
        { api: '공유 수락 (수신자)', bind: { keyShareId: '{{keyShareId}}' } },
      ],
    },
  },

  // ── 차량 등록 → 디지털 키 등록 → 공유 (순서대로 실행) ─────────────────────────
  // 로그인 상태에서 실행. 1 → 2 → 3 순으로 돌리면 등록·키·공유가 이어진다.
  {
    // 마스터차량 옵션(브랜드→모델→연식→색상variant)을 단계별로 조회해 첫 옵션을 자동 선택 → 차량 등록.
    // 옵션 응답은 envelope 없이 { selected, availableOptions } 원형. 등록 스텝에서 vehicleNumber 입력창이 뜬다.
    label: '차량 등록',
    data: {
      name: '차량 등록',
      flow: [
        { api: '통합 차량 옵션 조회 API', save: { brandId: '$.availableOptions.brands.0._id' } },
        { api: '통합 차량 옵션 조회 API', bind: { brandId: '{{brandId}}' }, save: { modelId: '$.availableOptions.models.0.modelId' } },
        { api: '통합 차량 옵션 조회 API', bind: { brandId: '{{brandId}}', modelId: '{{modelId}}' }, save: { yearId: '$.availableOptions.years.0._id' } },
        { api: '통합 차량 옵션 조회 API', bind: { brandId: '{{brandId}}', modelId: '{{modelId}}', yearId: '{{yearId}}' }, save: { carVariantId: '$.availableOptions.colors.0.variantId' } },
        // carVariantId 자동 바인딩. vehicleNumber(필수)는 비어 있어 실행 중 입력창이 뜬다.
        { api: '차량 등록', bind: { carVariantId: '{{carVariantId}}' }, save: { carId: '$.row._id' } },
      ],
    },
  },
  {
    // 내 차량 목록에서 첫 차량을 골라 그 carId 로 디지털 키 등록. deviceNumber(MAC, 필수)는 실행 중 입력.
    label: '디지털 키 등록',
    data: {
      name: '디지털 키 등록',
      flow: [
        { api: '차량 목록 조회', save: { carId: '$.rows.0._id' } },
        { api: '고객 디지털 키 등록', bind: { carId: '{{carId}}' } },
      ],
    },
  },
  {
    // 차량 목록에서 _id 선택 → 상세 조회로 digitalKey(keyId) 추출 → 회원번호 공유.
    // 공유 스텝은 shareType(필수)이 비어 있어 입력창이 뜨고 example 로 MEMBER_NO 가 채워짐 → memberNo(수신자)만 입력.
    label: '디지털키 공유',
    data: {
      name: '디지털키 공유',
      flow: [
        { api: '차량 목록 조회', save: { carId: '$.rows.0._id' } },
        { api: '차량 상세 조회', bind: { id: '{{carId}}' }, save: { keyId: '$.row.digitalKey.digitalKeyId' } },
        {
          api: '디지털 키 공유 생성',
          bind: { carId: '{{carId}}', keyId: '{{keyId}}' },
          values: { isRequireAccept: true, isRequireApproval: false },
        },
      ],
    },
  },

  // ── 앱: 주문/결제 ────────────────────────────────────────────────────────────
  // 체크아웃은 장바구니 내용을 그대로 주문으로 만든다(요청 본문에 items 없음).
  // 그래서 담기 → 체크아웃 순서가 필수다.
  {
    label: '주문 — 담기→체크아웃',
    data: {
      name: '주문 — 담기→체크아웃',
      flow: [
        { api: '고객 상품 목록 조회', save: { productId: '$.rows[saleStatus=ON_SALE]._id' } },
        { api: '장바구니 담기', bind: { productId: '{{productId}}' }, values: { quantity: 1 } },
        { api: '장바구니 조회' },
        // orderer/shippingAddress 는 중첩 객체라 값을 미리 채워둔다. 주소만 바꿔 쓰면 된다.
        {
          api: '체크아웃 (주문 생성)',
          values: {
            orderer: { name: '홍길동', phone: '01012345678' },
            shippingAddress: {
              recipientName: '홍길동',
              recipientPhone: '01012345678',
              address: '서울시 강남구 테헤란로 1',
              zipCode: '06000',
              request: '부재시 문앞',
            },
          },
          save: { orderId: '$.row.orderId', amount: '$.row.amount' },
        },
        { api: '주문 상세', bind: { orderId: '{{orderId}}' } },
      ],
    },
  },
  {
    // 토스 paymentKey 는 결제창에서만 나와 자동화가 못 태운다 → dev 는 'DEV-' 접두 키를
    // PG 호출 없이 승인한다(서버 DevPaymentClient, prod 에는 주입 안 됨).
    // amount 는 직전 체크아웃 응답값이 아니라 목록에서 다시 집어온다(플로우 단독 실행 가능하게).
    label: '주문 — 결제승인→구매확정',
    data: {
      name: '주문 — 결제승인→구매확정',
      flow: [
        { api: '내 주문 목록', save: { orderId: '$.rows.0.orderId', amount: '$.rows.0.totalPaymentAmount' } },
        {
          api: '결제 승인',
          bind: { orderId: '{{orderId}}', amount: '{{amount}}' },
          values: { paymentKey: 'DEV-flow-tester' },
        },
        { api: '주문 상세', bind: { orderId: '{{orderId}}' } },
        // orderItemIds 를 비우면 전체 라인 구매확정
        { api: '구매확정', bind: { orderId: '{{orderId}}' } },
      ],
    },
  },
  {
    label: '주문 — 배송 전 취소',
    data: {
      name: '주문 — 배송 전 취소',
      flow: [
        { api: '내 주문 목록', save: { orderId: '$.rows.0.orderId' } },
        { api: '배송 전 취소', bind: { orderId: '{{orderId}}' }, values: { reason: '단순 변심' } },
        { api: '주문 상세', bind: { orderId: '{{orderId}}' } },
      ],
    },
  },
  {
    // 배송완료(DELIVERED) 라인만 신청 가능하다.
    // 주문 상세의 items[0].orderItemId 를 그대로 신청에 넘긴다.
    label: '주문 — 반품/교환 신청→취소',
    data: {
      name: '주문 — 반품/교환 신청→취소',
      flow: [
        { api: '내 주문 목록', save: { orderId: '$.rows.0.orderId' } },
        { api: '주문 상세', bind: { orderId: '{{orderId}}' }, save: { orderItemId: '$.row.items.0.orderItemId' } },
        {
          api: '반품/교환 신청',
          bind: { orderId: '{{orderId}}' },
          values: {
            resolutionType: 'RETURN',
            reasonCode: 'DAMAGED',
            reasonText: '파손되어 도착',
            items: [{ orderItemId: '{{orderItemId}}', quantity: 1 }],
          },
          // 응답은 claimIds(배열) 이다
          save: { claimId: '$.row.claimIds.0' },
        },
        { api: '반품/교환 요청취소', bind: { orderId: '{{orderId}}', claimId: '{{claimId}}' } },
      ],
    },
  },

  // ── 앱: 조회 전용 ────────────────────────────────────────────────────────────
  {
    label: '상품 탐색',
    data: {
      name: '상품 탐색 (카테고리→목록→상세)',
      flow: [
        { api: '고객 카테고리 조회', save: { categoryId: '$.rows.0._id' } },
        { api: '고객 상품 목록 조회', bind: { categoryId: '{{categoryId}}' }, save: { productId: '$.rows.0._id' } },
        { api: '고객 상품 상세 조회', bind: { productId: '{{productId}}' } },
      ],
    },
  },
  {
    // 인증 없이도 도는 앱 초기 로딩 묶음. 서버 기동/시드 확인용으로 가장 먼저 돌려보면 좋다.
    label: '앱 초기 로딩',
    data: {
      name: '앱 초기 로딩 (버전/공지/배너/이벤트/약관)',
      flow: [
        { api: '앱버전 리스트 조회' },
        { api: '고객 공지사항 조회' },
        { api: '고객 배너 조회', save: { bannerId: '$.rows.0._id' } },
        { api: '배너 조회수 증가', bind: { bannerId: '{{bannerId}}' } },
        { api: '고객 이벤트 조회' },
        { api: '고객 이용 약관 조회' },
      ],
    },
  },
  {
    // 로그인 상태에서 실행. 정보 변경/푸시 설정은 본문이 비어 있어 실행 중 입력창이 뜬다.
    label: '내 정보',
    data: {
      name: '내 정보 (세션→정보변경→푸시설정)',
      flow: [
        { api: '소비자 세션 조회' },
        { api: '소비자 정보 변경' },
        { api: '푸시 수신 상태 수정' },
        { api: '소비자 세션 조회' },
      ],
    },
  },
]
