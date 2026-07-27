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
]
