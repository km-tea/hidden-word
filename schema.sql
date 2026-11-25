-- 참고용 스키마. 함수가 처음 실행될 때 자동으로 만들어주므로 직접 실행하지 않아도 돼요.
-- (Neon SQL 편집기에서 미리 만들어 두고 싶을 때만 사용하세요.)

create table if not exists rooms (
  code text primary key,
  mode text not null,              -- 'computer' | 'multi'
  answer text not null,
  status text not null default 'waiting',   -- waiting | playing | finished
  host_id text not null,
  winner_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists players (
  room_code text not null references rooms(code) on delete cascade,
  player_id text not null,
  name text not null,
  is_computer boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_code, player_id)
);

create table if not exists guesses (
  id bigserial primary key,
  room_code text not null references rooms(code) on delete cascade,
  player_id text not null,
  word text not null,
  semantic int not null,
  contextual int not null,
  relational int not null,
  total int not null,
  created_at timestamptz not null default now(),
  unique (room_code, player_id, word)
);

-- AI 판정 결과를 저장해 같은 단어쌍은 다시 묻지 않아요 (비용 절약 + 점수 일관성)
create table if not exists similarity_cache (
  word_a text not null,
  word_b text not null,
  semantic int not null,
  contextual int not null,
  relational int not null,
  total int not null,
  explanation text not null default '',
  created_at timestamptz not null default now(),
  primary key (word_a, word_b)
);
