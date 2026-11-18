function T = make_example_data(p, dur, events, seed)
% 실측 파일이 없을 때 쓰는 '가짜 실측' 데이터 (틀 확인용).
% calibrate.py CSV 와 같은 형식 (t, x, y, z, score) 으로 만든다.
% 일부러 기본 모델과 조금 다른 값(더 거친 노면, 무른 타이어, 옆 방향 흔들림)으로 만들어서
% 2단계 보정이 실제로 맞춰 가는 모습을 볼 수 있게 함.
q = p;
q.Gd = p.Gd * 1.8;
q.kt = p.kt * 0.85;
q.noise = 0.015;
S = simulate_ride(q, dur, events, seed);

rs = RandStream('mt19937ar', 'Seed', seed + 500);
x = 0.15 * S.acc + 0.03 * randn(rs, size(S.acc));   % 앞뒤 흔들림 조금
y = 0.10 * S.acc + 0.03 * randn(rs, size(S.acc));   % 좌우 흔들림 조금
z = 1 + S.acc;                                       % 세로 (중력 포함)
shock = abs(sqrt(x.^2 + y.^2 + z.^2) - 1);
score = make_score(shock, p.window, p.fs);
T = table(S.t, x, y, z, score, 'VariableNames', {'t', 'x', 'y', 'z', 'score'});
end
