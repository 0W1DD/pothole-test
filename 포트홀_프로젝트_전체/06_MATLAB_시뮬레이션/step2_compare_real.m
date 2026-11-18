%% 2단계: 실측 데이터와 비교 (시뮬레이션이 얼마나 믿을 만한지)
% calibrate.py 가 만든 calib_normal.csv, calib_bump.csv 를 data 폴더에 넣고 실행.
% 파일이 없으면 '예시 데이터'로 돌아가서 틀만 확인할 수 있음 (그래프 제목에 표시됨).
%
% 방법
%   1) 보정: 평소 주행 데이터만 써서 시뮬레이션 노면 거칠기(Gd)를 실측에 맞춤
%   2) 검증: 보정에 쓰지 않은 방지턱 데이터로 시뮬레이션이 맞는지 확인
%   → 방지턱 오차가 작으면 "이 모델은 믿을 만하다"고 말할 수 있음
clear; clc; close all;
if ~exist('results', 'dir'), mkdir('results'); end

% ===== 여기만 실측 상황에 맞게 고치기 =====
NORMAL_CSV = fullfile('data', 'calib_normal.csv');
BUMP_CSV   = fullfile('data', 'calib_bump.csv');
V_REAL     = 5.0;     % 기록할 때 평균 속도 (m/s). 18 km/h = 5 m/s
BUMP_H     = 0.05;    % 넘은 방지턱 높이 (m) - 자로 재기
BUMP_L     = 0.40;    % 넘은 방지턱 길이 (m)
BUMP_COUNT = 5;       % 방지턱 기록 때 넘은 횟수
% ==========================================

p = bike_params();
p.v = V_REAL;

% ----- 실측 데이터 불러오기 (없으면 예시 데이터) -----
is_example = ~(exist(NORMAL_CSV, 'file') && exist(BUMP_CSV, 'file'));
if is_example
    fprintf('실측 파일이 없어서 예시 데이터로 실행합니다. (data 폴더에 CSV를 넣으면 실측으로 바뀜)\n\n');
    real_n = make_example_data(p, 120, [], 7);
    ev_ex  = make_event('bump', 0, BUMP_H, BUMP_L);
    ev_ex  = repmat(ev_ex, 1, BUMP_COUNT);
    for k = 1:BUMP_COUNT, ev_ex(k).x0 = p.v * (6 + 9*(k-1)); end
    real_b = make_example_data(p, 6 + 9*BUMP_COUNT, ev_ex, 8);
    tag = ' (예시 데이터)';
else
    real_n = readtable(NORMAL_CSV);
    real_b = readtable(BUMP_CSV);
    tag = ' (실측)';
    % calibrate.py가 GPS속도(kmh칸)도 기록했으면 그평균속도로 V_REAL 자동으로바꿈
    if any(strcmp(real_n.Properties.VariableNames, 'kmh')) && isnumeric(real_n.kmh)
        kmh = real_n.kmh;
        kmh = kmh(~isnan(kmh) & kmh >= 6);     % 멈춘구간빼고
        if ~isempty(kmh)
            p.v = mean(kmh) / 3.6;
            fprintf('CSV의 GPS속도로 V_REAL 자동설정: %.1f km/h = %.2f m/s\n', mean(kmh), p.v);
        end
    end
end
[Rn.t, Rn.dev, Rn.shock, Rn.score, Rn.fs] = unpack_real(real_n);
[Rb.t, ~,      Rb.shock, Rb.score, Rb.fs] = unpack_real(real_b);
dur_n = min(Rn.t(end) - Rn.t(1), 300);   % 너무 길면 5분까지만 시뮬레이션
fprintf('실측 평소 주행 %.0f초 (센서 약 %.0f Hz), 방지턱 기록 %.0f초\n', ...
        Rn.t(end) - Rn.t(1), Rn.fs, Rb.t(end) - Rb.t(1));
if abs(Rn.fs - p.fs) > 50
    fprintf('  참고: 실측 측정 주기가 %.0f Hz 라서 시뮬레이션(%.0f Hz)과 차이가 있어요.\n', Rn.fs, p.fs);
end

% ----- 1) 보정: 평소 주행 충격 점수의 중간값이 같아지도록 노면 거칠기 맞추기 -----
pf = p;
fprintf('\n[보정] 평소 주행 데이터로 노면 거칠기 맞추는 중');
for it = 1:3
    S = simulate_ride(pf, dur_n, [], 11);
    r = median(Rn.score) / median(S.score);
    r = min(max(r, 0.2), 5);
    pf.Gd = pf.Gd * r^2;          % 선형 모델이라 진동 크기 ∝ sqrt(Gd)
    fprintf('.');
end
Sn = simulate_ride(pf, dur_n, [], 11);
fprintf('\n  노면 거칠기 Gd = %.1f x 10^-6 m^3 (ISO 8608 %s등급 정도)\n', pf.Gd*1e6, iso_class(pf.Gd));

% ----- 2) 검증: 같은 조건으로 방지턱 시뮬레이션 -----
ev = make_event('bump', 0, BUMP_H, BUMP_L);
ev = repmat(ev, 1, BUMP_COUNT);
for k = 1:BUMP_COUNT, ev(k).x0 = pf.v * (5 + 8*(k-1)); end
Sb = simulate_ride(pf, 5 + 8*BUMP_COUNT + 3, ev, 12);

[~, peak_real] = find_peaks_greedy(Rb.t, Rb.score, BUMP_COUNT, p.cooldown);
[~, peak_sim]  = find_peaks_greedy(Sb.t, Sb.score, BUMP_COUNT, p.cooldown);

% ----- 비교표 -----
names = { '평소: 가속도 RMS (g)'; '평소: 충격점수 중간값 (g)'; '평소: 충격점수 상위 1% (g)'; ...
          '평소: 충격점수 상위 0.1% (g)'; '방지턱: 최고값 평균 (g)'; '방지턱: 최고값 최소 (g)'; ...
          '방지턱: 최고값 최대 (g)'; '구별 여유 (방지턱 최소 / 평소 상위 0.1%)' };
realv = [ rms_simple(Rn.dev); median(Rn.score); prctile_simple(Rn.score, 99); prctile_simple(Rn.score, 99.9); ...
          mean(peak_real); min(peak_real); max(peak_real); min(peak_real) / prctile_simple(Rn.score, 99.9) ];
simv  = [ rms_simple(Sn.acc); median(Sn.score); prctile_simple(Sn.score, 99); prctile_simple(Sn.score, 99.9); ...
          mean(peak_sim); min(peak_sim); max(peak_sim); min(peak_sim) / prctile_simple(Sn.score, 99.9) ];
err = (simv - realv) ./ realv * 100;
role = {'검증'; '보정에 사용'; '검증'; '검증'; '검증'; '검증'; '검증'; '검증'};
T = table(names, round(realv, 3), round(simv, 3), round(err, 1), role, ...
          'VariableNames', {'Item', 'Real', 'Sim', 'Error_pct', 'Role'});

% 스펙트럼(진동 주파수 분포) 모양 비교
[fr, Pr] = simple_psd(resample_uniform(Rn.t, Rn.dev, p.fs), p.fs, 1024);
[fs_, Ps] = simple_psd(Sn.acc, p.fs, 1024);
band = fr >= 1 & fr <= 100;
cc = corrcoef(log10(Pr(band)), log10(Ps(band)));
psd_r = cc(1, 2);

fprintf('\n===== 실측 vs 시뮬레이션%s =====\n', tag);
disp(T);
fprintf('진동 스펙트럼 모양 일치도 (1~100 Hz, 로그 상관계수) r = %.2f\n', psd_r);
fprintf('방지턱 최고값 평균 오차 %.0f%% (보정에 안 쓴 데이터라 이게 신뢰성 지표)\n', err(5));
try
    writetable(T, fullfile('results', 'step2_compare_table.csv'), 'Encoding', 'UTF-8');
catch
    writetable(T, fullfile('results', 'step2_compare_table.csv'));
end
save(fullfile('results', 'fitted_params.mat'), 'pf', 'is_example');
fprintf('\n보정된 모델 저장: results/fitted_params.mat (3단계에서 자동으로 사용)\n');

% ----- 그림 -----
f = figure('Name', '2단계 실측 비교', 'Position', [80 80 1100 780]);

subplot(2,2,1);   % 시간 파형 10초
mr = Rn.t - Rn.t(1) < 10;  ms = Sn.t < 10;
plot(Rn.t(mr) - Rn.t(1), Rn.dev(mr), 'k'); hold on;
plot(Sn.t(ms), Sn.acc(ms), 'r');
grid on; xlabel('시간 (s)'); ylabel('가속도 - 1g (g)');
legend('실측', '시뮬레이션', 'Location', 'best');
title(['평소 주행 파형 10초' tag]);

subplot(2,2,2);   % 충격 점수 분포
edges = linspace(0, max([prctile_simple(Rn.score, 99.9), prctile_simple(Sn.score, 99.9)]) * 1.2, 50);
histogram(Rn.score, edges, 'Normalization', 'probability', 'FaceColor', [0.3 0.3 0.3]); hold on;
histogram(Sn.score, edges, 'Normalization', 'probability', 'FaceColor', [0.9 0.2 0.2], 'FaceAlpha', 0.5);
grid on; xlabel('충격 점수 (g)'); ylabel('비율');
legend('실측', '시뮬레이션'); title('평소 주행 충격 점수 분포');

subplot(2,2,3);   % 스펙트럼
loglog(fr(band), Pr(band), 'k'); hold on;
loglog(fs_(band), Ps(band), 'r');
grid on; xlabel('주파수 (Hz)'); ylabel('PSD (g^2/Hz)');
legend('실측', '시뮬레이션'); title(sprintf('진동 스펙트럼 (일치도 r = %.2f)', psd_r));

subplot(2,2,4);   % 방지턱 최고값
n = min(numel(peak_real), numel(peak_sim));
bar([sort(peak_real(1:n)), sort(peak_sim(1:n))]); grid on;
hline(prctile_simple(Rn.score, 99.9), 'k--', '평소 상위 0.1%');
xlabel('방지턱 (작은 순)'); ylabel('충격 점수 최고값 (g)');
legend('실측', '시뮬레이션', 'Location', 'northwest');
title(sprintf('방지턱 검증 (평균 오차 %.0f%%)', err(5)));

saveas(f, fullfile('results', 'step2_compare.png'));
fprintf('그림 저장: results/step2_compare.png\n');


%% ---- 이 스크립트에서만 쓰는 함수 ----
function [t, dev, shock, score, fs] = unpack_real(R)
% calibrate.py CSV (t, x, y, z, score) → 같은 정의의 값들
t     = R.t - R.t(1);
mag   = sqrt(R.x.^2 + R.y.^2 + R.z.^2);
dev   = mag - 1;              % 중력 뺀 가속도 크기
shock = abs(dev);
score = R.score;
fs    = 1 / median(diff(t));
end

function y = resample_uniform(t, x, fs)
[t, iu] = unique(t);          % 같은 시각이 두 번 찍힌 줄 제거
x = x(iu);
tu = (t(1) : 1/fs : t(end))';
y  = interp1(t, x, tu, 'linear');
end

function r = rms_simple(x)
r = sqrt(mean((x - mean(x)).^2));
end

function c = iso_class(Gd)
if Gd < 32e-6, c = 'A';
elseif Gd < 128e-6, c = 'B';
elseif Gd < 512e-6, c = 'C';
else, c = 'D';
end
end
