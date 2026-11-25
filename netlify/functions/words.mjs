// 정답 후보 단어 목록 — 초등학생이 알 만한 보편적인 단어들.
// 동음이의어(눈, 배, 다리 등)는 일부러 뺐어요. 단어를 추가하고 싶으면 아래 배열에 한글 단어만 넣으면 돼요.

const GROUPS = {
  동물: `강아지 고양이 토끼 호랑이 사자 코끼리 기린 원숭이 곰 돼지 소 말 닭 오리 개구리
         거북이 고래 상어 나비 벌 개미 거미 펭귄 독수리 다람쥐 여우 늑대 사슴 악어 뱀 문어`,
  과일채소: `사과 바나나 포도 딸기 수박 귤 복숭아 감 당근 감자 고구마 오이 토마토 양파 옥수수 호박 레몬`,
  음식: `김밥 라면 빵 우유 치즈 피자 햄버거 떡볶이 비빔밥 아이스크림 과자 케이크 달걀 쌀 김치 사탕 주스 소시지`,
  학교: `학교 교실 선생님 친구 책 연필 지우개 가방 공책 칠판 시계 가위 운동장 도서관 색연필 교과서`,
  자연: `하늘 구름 비 바람 태양 달 별 무지개 산 바다 강 호수 나무 꽃 숲 섬 돌 모래 불 얼음 번개 우주`,
  몸: `손 발 코 입 귀 머리 팔 무릎 어깨 손가락 얼굴 머리카락`,
  생활: `집 문 창문 침대 의자 책상 냉장고 텔레비전 거울 우산 신발 모자 양말 옷 안경 장갑 이불 컵 숟가락 젓가락 비누 칫솔 수건`,
  탈것: `자동차 버스 기차 비행기 자전거 지하철 로켓 헬리콥터 오토바이 트럭`,
  놀이: `축구 야구 축구공 노래 그림 피아노 기타 풍선 장난감 인형 줄넘기 연 퍼즐 수영`,
  기타: `편지 돈 열쇠 전화 컴퓨터 카메라 생일 선물 병원 의사 경찰 소방관 시장 공원 놀이터 도로 신호등 다리미 지갑`,
};

export const WORDS = [
  ...new Set(
    Object.values(GROUPS)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean),
  ),
];

export function pickAnswer() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

// exclude에 들어 있는 단어를 뺀 무작위 단어 (컴퓨터 대체 추측용)
export function pickRandom(exclude = []) {
  const banned = new Set(exclude);
  const pool = WORDS.filter((w) => !banned.has(w));
  const list = pool.length ? pool : WORDS;
  return list[Math.floor(Math.random() * list.length)];
}
