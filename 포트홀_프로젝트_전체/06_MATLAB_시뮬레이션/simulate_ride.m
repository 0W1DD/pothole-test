function out = simulate_ride(p, dur, events, seed)
% 자전거 주행 시뮬레이션 → 센서가 읽을 값과 충격 점수
%   out.t      시간 (s), 400 Hz
%   out.acc    센서 세로 가속도 (중력 뺀 값, g)
%   out.shock  |가속도 크기 - 1|  (파이썬 코드의 shock 과 같은 정의)
%   out.score  충격 점수 (shock 의 WINDOW 초 평균, 파이썬 Scorer 와 같음)
%   out.road   센서 시각에 맞춘 앞바퀴 노면 높이 (m)

[x, z] = make_road(p, dur, events, seed);

dt = 1 / p.fs_sim;
t  = (0 : dt : dur - dt)';
xf = p.v * t;                                   % 앞바퀴 위치
zf = interp1(x, z, xf,       'linear', 0);      % 앞바퀴가 밟는 노면
zr = interp1(x, z, xf - p.L, 'linear', 0);      % 뒷바퀴 (축거만큼 뒤)

% Simulink 모델로 계산
if isfield(p, 'use_simulink') && p.use_simulink
    out = run_simulink_model(p, t, zf, zr, seed);
    out.road = interp1(t, zf, out.t, 'linear', 'extrap');
    return;
end

% 같은 식을 MATLAB 코드로 계산
a =p.wf * wheel_response(p, zf, dt) + (1 - p.wf) * wheel_response(p, zr, dt);

% 센서 주기(400 Hz)로 뽑기
step = round(p.fs_sim / p.fs);
idx  = 1 : step : numel(t);
out.t    = t(idx);
out.road = zf(idx);
a = a(idx);

% 센서 특성: 잡음, 분해능, 측정 범위
rs   = RandStream('mt19937ar', 'Seed', seed + 100);
meas = a + p.noise * randn(rs, size(a));
meas = round(meas / p.lsb) * p.lsb;
meas = min(max(meas, -p.range), p.range);

out.acc   = meas;
out.shock = abs(abs(1 + meas) - 1);             % 중력(1g) 포함 크기에서 1 빼기
out.score = make_score(out.shock, p.window, p.fs);
end


function acc = wheel_response(p, zr, dt)
% 바퀴 하나 2자유도 모델. 상태 = [z1, z1', z2, z2'], 입력 = [zr, zr']
m1 = p.m1; m2 = p.m2; kt = p.kt; ct = p.ct; kr = p.kr; cr = p.cr;
A = [ 0             1             0       0;
     -(kt+kr)/m1   -(ct+cr)/m1    kr/m1   cr/m1;
      0             0             0       1;
      kr/m2         cr/m2        -kr/m2  -cr/m2 ];
B = [ 0      0;
      kt/m1  ct/m1;
      0      0;
      0      0 ];

% 이산화 (영차 유지). 툴박스 없이 expm 만 사용
M = zeros(6);
M(1:4, 1:4) = A;
M(1:4, 5:6) = B;
E  = expm(M * dt);
Ad = E(1:4, 1:4);
Bd = E(1:4, 5:6);

U = [zr(:)'; gradient(zr(:), dt)'];             % 2 x N
N = numel(zr);
X = zeros(4, N);
xk = [zr(1); 0; zr(1); 0];                      % 처음엔 노면 위에 가만히 있는 상태
for k = 1:N
    X(:, k) = xk;
    xk = Ad * xk + Bd * U(:, k);
end
acc = (A(2, :) * X + B(2, :) * U)' / 9.81;      % 자전거(센서) 가속도, g 단위
end
