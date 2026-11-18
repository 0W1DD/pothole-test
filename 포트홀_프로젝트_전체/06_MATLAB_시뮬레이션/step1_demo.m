%% 1단계: 시뮬레이션 데모
% 60초 동안 보통 도로를 달리면서 방지턱 2개, 포트홀 1개를 지나는 상황.
% 센서 값, 충격 점수, 감지 결과를 그래프로 보여 준다.
clear; clc; close all;
if ~exist('results', 'dir'), mkdir('results'); end

p   = bike_params();
dur = 60;                   % 주행 시간 (s)
th  = 1.2;                  % 감지 기준값 (g) - 3단계에서 고른 값으로 바꿔 보기
p.threshold = th;

% 방지턱/포트홀 위치 (m) = 속도 x 시각
ev = [ make_event('bump',    p.v*15, 0.05, 0.40), ...   % 15초쯤: 높이 5cm, 길이 40cm 방지턱
       make_event('pothole', p.v*30, 0.04, 0.30), ...   % 30초쯤: 깊이 4cm, 길이 30cm 포트홀
       make_event('bump',    p.v*45, 0.03, 0.50) ];     % 45초쯤: 높이 3cm 낮은 방지턱

fprintf('시뮬레이션 중... (속도 %.1f m/s = %.0f km/h)\n', p.v, p.v*3.6);
out  = simulate_ride(p, dur, ev, 1);
if isfield(out, 'tdet')
    tdet = out.tdet;                                    % Simulink 감지기 결과
    open_system('bike_pothole_model');                  % 모델 블록도 열기
else
    tdet = detect_events(out.t, out.score, th, p.cooldown);
end

% 결과 출력
fprintf('\n평소 주행 충격 점수: 중간값 %.2fg, 상위 1%% %.2fg\n', ...
        median(out.score), prctile_simple(out.score, 99));
fprintf('기준 %.2fg 로 감지된 시각:\n', th);
for k = 1:numel(tdet)
    fprintf('  %.2f초\n', tdet(k));
end
fprintf('실제 장애물 시각: %s 초\n', mat2str(round([ev.x0]/p.v, 1)));

% ===== 그림 1: 전체 주행 =====
f1 = figure('Name', '1단계 시뮬레이션', 'Position', [100 100 1000 750]);
subplot(3,1,1);
plot(out.t, out.road*100, 'k'); grid on;
ylabel('노면 높이 (cm)'); title('노면 (앞바퀴 기준)');
subplot(3,1,2);
plot(out.t, out.acc, 'b'); grid on;
ylabel('세로 가속도 (g)'); title('센서(ADXL345) 측정값 - 중력 제외');
subplot(3,1,3);
plot(out.t, out.score, 'b'); hold on; grid on;
hline(th, 'r--', sprintf('기준 %.2fg', th));
for k = 1:numel(tdet)
    plot(tdet(k), th, 'rv', 'MarkerFaceColor', 'r', 'MarkerSize', 8);
end
for k = 1:numel(ev)
    vline(ev(k).x0 / p.v, 'g:');
end
xlabel('시간 (s)'); ylabel('충격 점수 (g)');
title(sprintf('충격 점수 (%.0f ms 평균)  ▼ 감지,  초록 점선 = 실제 장애물', p.window*1000));
saveas(f1, fullfile('results', 'step1_ride.png'));

% ===== 그림 2: 방지턱 하나 확대 (앞바퀴·뒷바퀴 두 번 충격) =====
t0 = ev(1).x0 / p.v;
m  = out.t > t0 - 0.5 & out.t < t0 + 1.0;
f2 = figure('Name', '방지턱 확대', 'Position', [150 150 800 450]);
subplot(2,1,1);
plot(out.t(m), out.acc(m), 'b'); grid on;
vline(t0, 'g:'); vline(t0 + p.L/p.v, 'm:');
ylabel('가속도 (g)'); title('방지턱 확대: 초록 = 앞바퀴, 보라 = 뒷바퀴');
subplot(2,1,2);
plot(out.t(m), out.score(m), 'b'); grid on; hold on;
hline(th, 'r--', '기준');
xlabel('시간 (s)'); ylabel('충격 점수 (g)');
saveas(f2, fullfile('results', 'step1_bump_zoom.png'));

fprintf('\n그림 저장: results/step1_ride.png, results/step1_bump_zoom.png\n');


