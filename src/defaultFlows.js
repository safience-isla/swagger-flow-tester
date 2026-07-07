// 기본 제공 플로우 (컴팩트 포맷). 앱 첫 로드 시 저장된 플로우에 자동 시드되고,
// 가져오기 모달의 '기본 플로우' 프리셋 버튼으로도 불러올 수 있다.
//
// 회원가입/로그인은 중간에 문자 인증코드(code) 입력이 필요하므로 한 번에 실행하지 않고
// 각 스텝을 개별 실행(Send)하며 사용한다.
//   save : 이 스텝 응답값을 변수로 저장  ($.row._id → 응답은 ObjectResponse 로 {row} 래핑됨)
//   bind : 이전 스텝 변수값을 이 스텝 파라미터에 자동 연결
// confirm 의 code 는 SMS 로 받는 값이라 자동화 불가 → 실행 시 손입력.
export const DEFAULT_FLOWS = [
  {
    label: '회원가입',
    data: {
      name: '회원가입 (휴대폰)',
      flow: [
        { api: 'verification/signup/phone', save: { authId: '$.row._id' } },
        // confirm: _id 는 발송 응답에서 자동, code 는 SMS 손입력. 응답 id 는 다음 스텝 phoneAuthId 로 저장.
        { api: 'verification/confirm', bind: { _id: '{{authId}}' }, save: { phoneAuthId: '$.row.id' } },
        {
          api: 'session/sign-up-phone',
          bind: { phoneAuthId: '{{phoneAuthId}}' }, // confirm 응답 row.id 자동 연결
          values: {
            pushToken: 'pushToken',
            appVersion: '1.0.0',
            isPersonalPushAgreed: true,
            isEventAgreed: true,
            isAdAndDataAgreed: true,
          },
          setAuth: { Authorization: '$.row.session.accessToken' }, // 응답 session.accessToken → 전역 Authorization 헤더
        },
      ],
    },
  },
  {
    label: '로그인',
    data: {
      name: '로그인 (휴대폰)',
      flow: [
        { api: 'verification/login/phone', save: { authId: '$.row._id' } },
        // confirm: _id 는 발송 응답에서 자동, code 는 SMS 손입력. 응답 id 는 sign-in authId 로 저장.
        { api: 'verification/confirm', bind: { _id: '{{authId}}' }, save: { verifiedId: '$.row.id' } },
        {
          api: 'session/sign-in-phone',
          bind: { authId: '{{verifiedId}}' }, // confirm 응답 row.id 자동 연결
          values: { pushToken: 'pushToken', appVersion: '1.0.0' },
          setAuth: { Authorization: '$.row.session.accessToken' }, // 응답 session.accessToken → 전역 Authorization 헤더
        },
      ],
    },
  },
  {
    // 인증 필요 → 로그인 플로우로 전역 Authorization 세팅 후 실행.
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
]
