%% 3단계: 감지 신뢰성 + 기준값(THRESHOLD)·평균 시간(WINDOW) 고르기
% 속도, 노면, 방지턱 크기, 포트홀 크기를 무작위로 바꿔 가며 여러 번 주행시켜
%   - 감지율   : 실제 방지턱/포트홀 중 몇 % 를 잡았나
%   - 오감지   : 장애물이 없는데 감지한 횟수 (1분당)
% 를 기준값·평균 시간마다 계산하고, 가장 여유 있는 조합을 추천한다.
% 2단계를 먼저 돌렸으면 실측에 맞춘 모델(results/fitted_params.mat)을 자동으로 씀.
clear; clc; close all;
if ~exist('results', 'dir'), mkdir('results'); end

% ===== 설정 =====
N_TRIAL   = 30;                        % 반복 주행 횟수 (많을수록 정확, 느림)
DUR       = 60;                        % 한 번 주행 시간 (s)
SPEEDS    = [3 7];                     % 속도 범위 (m/s) = 11~25 km/h
BUMP_H    = [0.03 0.07];               % 방지턱 높이 범위 (m)
BUMP_L    = [0.30 0.60];               % 방지턱 길이 범위 (m)
HOLE_D    = [0.03 0.06];               % 포트홀 깊이 범위 (m)
HOLE_L    = [0.20 0.50];               % 포트홀 길이 범위 (m)
ROAD_MUL  = [0.5 2.0];                 % 노면 거칠기 배율 범위 (좋은 길 ~ 거친 길)
WINDOWS   = [0.02 0.05 0.10 0.20];     % 비교할 평균 시간 (s)
THS       = 0.2 : 0.05 : 4.0;          % 비교할 기준값 (g)
GOAL_DET  = 95;                        % 목표 감지율 (%)
GOAL_FA   = 0.5;                       % 허용 오감지 (1분당)
% =================

p0 = bike_params();
if exist(fullfile('results', 'fitted_params.mat'), 'file')
    S = load(fullfile('results', 'fitted_params.mat'));
    p0 = S.pf;
    if S.is_example
        fprintf('2단계 보정 모델 사용 (단, 예시 데이터로 보정한 것)\n');
    else
        fprintf('2단계에서 실측에 맞춘 모델 사용\n');
    end
else
    fprintf('보정 모델 없음 → 기본값 사용 (2단계를 먼저 돌리면 더 정확)\n');
end

% ----- 1) 무작위 주행 N_TRIAL 번 -----
rs = RandStream('mt19937ar', 'Seed', 2026);
trial = struct('v', {}, 't', {}, 'shock', {}, 'lo', {}, 'hi', {}, 'kind', {});
fprintf('주행 시뮬레이션 %d회: ', N_TRIAL);
for k = 1:N_TRIAL
    p = p0;
    p.v  = SPEEDS(1) + diff(SPEEDS) * rand(rs);
    p.Gd = p0.Gd * (ROAD_MUL(1) + diff(ROAD_MUL) * rand(rs));

    te = [10 25 40 52] + 3 * rand(rs, 1, 4);           % 장애물 만나는 시각 (s)
    ev = make_event('bump', 0, 0, 0);
    ev = repmat(ev, 1, 4);
    for i = 1:4
        if i < 4
            ev(i) = make_event('bump', p.v*te(i), rnd(rs, BUMP_H), rnd(rs, BUMP_L));
        else
            ev(i) = make_event('pothole', p.v*te(i), rnd(rs, HOLE_D), rnd(rs, HOLE_L));
        end
    end

    out = simulate_ride(p, DUR, ev, 100 + k);
    trial(k).v     = p.v;
    trial(k).t     = out.t;
    trial(k).shock = out.shock;
    trial(k).lo    = [ev.x0]' / p.v - 0.1;                          % 이 시간 사이에 감지되면 정답
    trial(k).hi    = ([ev.x0]' + [ev.l]' + p.L) / p.v + 0.3;
    trial(k).kind  = {ev.kind}';
    fprintf('.');
end
fprintf(' 완료\n');

% ----- 2) 평균 시간 x 기준값 마다 감지율, 오감지 계산 -----
nW = numel(WINDOWS); nT = numel(THS);
DET = zeros(nW, nT);   FA = zeros(nW, nT);
for w = 1:nW
    for k = 1:N_TRIAL
        score = make_score(trial(k).shock, WINDOWS(w), p0.fs);
        for j = 1:nT
            [d, f] = evaluate(trial(k), score, THS(j), p0.cooldown);
            DET(w, j) = DET(w, j) + d;
            FA(w, j)  = FA(w, j) + f;
        end
    end
end
n_event = 4 * N_TRIAL;
DET = DET / n_event * 100;                 % %
FA  = FA / (N_TRIAL * DUR / 60);           % 1분당

% ----- 3) 추천: 목표를 만족하는 기준값 구간이 가장 넓은 평균 시간, 그 구간의 가운데 -----
best_w = 0; best_len = 0; best_j = 0;
for w = 1:nW
    okv = DET(w, :) >= GOAL_DET & FA(w, :) <= GOAL_FA;
    [len, mid] = longest_run(okv);
    if len > best_len
        best_len = len; best_w = w; best_j = mid;
    end
end
if best_w == 0
    % 목표를 만족하는 조합이 없으면: 감지율 - 오감지 벌점 이 가장 좋은 것
    [~, idx] = max(DET(:) - 20 * FA(:));
    [best_w, best_j] = ind2sub(size(DET), idx);
    fprintf('\n목표(감지율 %d%% 이상, 오감지 %.1f회/분 이하)를 만족하는 조합이 없어요. 가장 나은 값을 고릅니다.\n', GOAL_DET, GOAL_FA);
end
W_BEST  = WINDOWS(best_w);
TH_BEST = THS(best_j);

fprintf('\n===== 추천 설정 =====\n');
fprintf('  WINDOW    = %.2f   (충격 점수 평균 시간, 초)\n', W_BEST);
fprintf('  THRESHOLD = %.2f   (감지 기준값, g)\n', TH_BEST);
fprintf('  → 감지율 %.0f%%, 오감지 %.2f회/분\n', DET(best_w, best_j), FA(best_w, best_j));
if best_len > 0
    fprintf('  안전한 기준값 구간: %.2f ~ %.2f g (이 안이면 목표 만족)\n', ...
            THS(best_j - floor((best_len-1)/2)), THS(best_j + ceil((best_len-1)/2)));
end
fprintf('\n평균 시간별 결과 (각 평균 시간에서 목표를 만족하는 기준값 구간):\n');
for w = 1:nW
    okv = DET(w, :) >= GOAL_DET & FA(w, :) <= GOAL_FA;
    if any(okv)
        fprintf('  WINDOW %.2f s : %.2f ~ %.2f g\n', WINDOWS(w), min(THS(okv)), max(THS(okv)));
    else
        fprintf('  WINDOW %.2f s : 없음\n', WINDOWS(w));
    end
end

% ----- 4) 추천 설정에서 속도별, 종류별 감지율 -----
v_all = []; hit_all = []; kind_all = {};
for k = 1:N_TRIAL
    score = make_score(trial(k).shock, W_BEST, p0.fs);
    tdet  = detect_events(trial(k).t, score, TH_BEST, p0.cooldown);
    for i = 1:numel(trial(k).lo)
        hit = any(tdet >= trial(k).lo(i) & tdet <= trial(k).hi(i));
        v_all(end+1, 1) = trial(k).v;        %#ok<AGROW>
        hit_all(end+1, 1) = hit;             %#ok<AGROW>
        kind_all{end+1, 1} = trial(k).kind{i}; %#ok<AGROW>
    end
end
is_bump = strcmp(kind_all, 'bump');
fprintf('\n추천 설정에서 종류별 감지율: 방지턱 %.0f%%, 포트홀 %.0f%%\n', ...
        mean(hit_all(is_bump)) * 100, mean(hit_all(~is_bump)) * 100);

R = table(WINDOWS(best_w), TH_BEST, DET(best_w, best_j), FA(best_w, best_j), ...
          'VariableNames', {'WINDOW_s', 'THRESHOLD_g', 'Detection_pct', 'FalseAlarm_per_min'});
writetable(R, fullfile('results', 'step3_recommended.csv'));

% ----- 그림 1: 감지율 vs 오감지 (평균 시간별) -----
f1 = figure('Name', '3단계 신뢰성', 'Position', [80 80 1100 450]);
subplot(1,2,1); hold on; grid on;
cols = lines(nW);
for w = 1:nW
    plot(FA(w, :), DET(w, :), '-', 'Color', cols(w, :), 'LineWidth', 1.5);
end
plot(FA(best_w, best_j), DET(best_w, best_j), 'kp', 'MarkerSize', 16, 'MarkerFaceColor', 'y');
xlabel('오감지 (회/분)'); ylabel('감지율 (%)');
legend([arrayfun(@(w) sprintf('WINDOW %.2fs', w), WINDOWS, 'UniformOutput', false), {'추천'}], ...
       'Location', 'southeast');
title('감지율 vs 오감지 (왼쪽 위로 갈수록 좋음)');
xlim([0 max(3, GOAL_FA * 4)]); ylim([0 105]);

% ----- 그림 2: 추천 평균 시간에서 기준값에 따른 변화 -----
subplot(1,2,2);
yyaxis left;
plot(THS, DET(best_w, :), 'LineWidth', 1.5); ylabel('감지율 (%)'); ylim([0 105]);
yyaxis right;
plot(THS, FA(best_w, :), 'LineWidth', 1.5); ylabel('오감지 (회/분)');
grid on; xlabel('기준값 THRESHOLD (g)');
vline(TH_BEST, 'k--');
title(sprintf('WINDOW %.2fs 에서 기준값 고르기 (추천 %.2fg)', W_BEST, TH_BEST));
saveas(f1, fullfile('results', 'step3_reliability.png'));

% ----- 그림 3: 속도별 감지율 -----
f2 = figure('Name', '속도별 감지율', 'Position', [120 120 600 400]);
edges_v = SPEEDS(1) : 1 : SPEEDS(2);
rate = nan(1, numel(edges_v) - 1);
for b = 1:numel(edges_v) - 1
    m = v_all >= edges_v(b) & v_all < edges_v(b+1);
    if any(m), rate(b) = mean(hit_all(m)) * 100; end
end
bar(edges_v(1:end-1) * 3.6 + 1.8, rate); grid on; ylim([0 105]);
xlabel('속도 (km/h)'); ylabel('감지율 (%)');
title(sprintf('속도별 감지율 (THRESHOLD %.2fg, WINDOW %.2fs)', TH_BEST, W_BEST));
saveas(f2, fullfile('results', 'step3_speed.png'));

fprintf('\n그림 저장: results/step3_reliability.png, results/step3_speed.png\n');
fprintf('추천값은 calibrate.py / pothole_detect.py 의 WINDOW, THRESHOLD 에 넣어 비교해 보세요.\n');


%% ---- 이 스크립트에서만 쓰는 함수 ----
function v = rnd(rs, range)
v = range(1) + diff(range) * rand(rs);
end

function [n_hit, n_fa] = evaluate(tr, score, th, cooldown)
tdet = detect_events(tr.t, score, th, cooldown);
used = false(size(tdet));
n_hit = 0;
for i = 1:numel(tr.lo)
    m = tdet >= tr.lo(i) & tdet <= tr.hi(i);
    n_hit = n_hit + any(m);
    used = used | m;
end
n_fa = sum(~used);
end

function [len, mid] = longest_run(okv)
% 연속으로 true 인 가장 긴 구간의 길이와 가운데 위치
len = 0; mid = 0; cur = 0;
for i = 1:numel(okv)
    if okv(i)
        cur = cur + 1;
        if cur > len
            len = cur; mid = (i - cur + 1) + floor((cur - 1) / 2);
        end
    else
        cur = 0;
    end
end
end
