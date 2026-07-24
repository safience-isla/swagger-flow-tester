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
]
