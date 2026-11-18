function build_bike_model(force)
% Simulink 모델 bike_pothole_model.slx 를 블록 단위로 자동으로 그려서 저장한다.
%   build_bike_model        : 파일이 없을 때만 만들기
%   build_bike_model(true)  : 있어도 새로 만들기 (직접 고친 내용은 사라짐)
%
% 모델 구조 (최상위)
%   노면(From Workspace) → 앞바퀴/뒷바퀴 2자유도 → 섞기(wf) → g 단위
%   → ADXL345 (400Hz 샘플, 잡음, 분해능, ±16g) → 충격 |  |a+1| - 1 |
%   → 충격 점수 (WINDOW 평균, FIR) → 감지기 (기준값 + 쿨다운) → To Workspace / Scope
%
% 블록 파라미터는 전부 변수 이름으로 들어가 있고, 값은 run_simulink_model.m 이
% 실행 직전에 base 작업공간에 넣어 준다.

if nargin < 1, force = false; end
mdl = 'bike_pothole_model';
if ~force && exist([mdl '.slx'], 'file')
    return;
end
if bdIsLoaded(mdl), close_system(mdl, 0); end
if exist([mdl '.slx'], 'file'), delete([mdl '.slx']); end

new_system(mdl);
load_system(mdl);

% ===== 노면 입력 =====
B(mdl, 'simulink/Sources/From Workspace', 'road_front',     [30  40 110  70], 'VariableName', 'zf_data');
B(mdl, 'simulink/Sources/From Workspace', 'road_front_dot', [30 100 110 130], 'VariableName', 'zfd_data');
B(mdl, 'simulink/Sources/From Workspace', 'road_rear',      [30 200 110 230], 'VariableName', 'zr_data');
B(mdl, 'simulink/Sources/From Workspace', 'road_rear_dot',  [30 260 110 290], 'VariableName', 'zrd_data');

% ===== 앞바퀴 / 뒷바퀴 (2자유도 서브시스템) =====
build_wheel([mdl '/Front_wheel'], [170  50 290 120], 'z0_front');
build_wheel([mdl '/Rear_wheel'],  [170 210 290 280], 'z0_rear');
L(mdl, 'road_front/1', 'Front_wheel/1');  L(mdl, 'road_front_dot/1', 'Front_wheel/2');
L(mdl, 'road_rear/1',  'Rear_wheel/1');   L(mdl, 'road_rear_dot/1',  'Rear_wheel/2');

% ===== 센서 위치로 섞기 → g 단위 =====
B(mdl, 'simulink/Math Operations/Gain', 'w_front', [340  70 390 100], 'Gain', 'wf');
B(mdl, 'simulink/Math Operations/Gain', 'w_rear',  [340 230 390 260], 'Gain', '1-wf');
B(mdl, 'simulink/Math Operations/Sum',  'mix',     [430 150 460 180], 'Inputs', '++');
B(mdl, 'simulink/Math Operations/Gain', 'to_g',    [490 150 540 180], 'Gain', '1/9.81');
L(mdl, 'Front_wheel/1', 'w_front/1');  L(mdl, 'Rear_wheel/1', 'w_rear/1');
L(mdl, 'w_front/1', 'mix/1');          L(mdl, 'w_rear/1', 'mix/2');
L(mdl, 'mix/1', 'to_g/1');

% ===== ADXL345 센서 =====
B(mdl, 'simulink/Discrete/Zero-Order Hold',   'ADXL_sample',     [580 150 620 180], 'SampleTime', '1/fs');
B(mdl, 'simulink/Sources/Random Number',      'ADXL_noise',      [580 230 620 260], ...
  'Mean', '0', 'Variance', 'noise^2', 'Seed', 'noise_seed', 'SampleTime', '1/fs');
B(mdl, 'simulink/Math Operations/Sum',        'add_noise',       [660 155 690 185], 'Inputs', '++');
B(mdl, 'simulink/Discontinuities/Quantizer',  'ADXL_resolution', [720 150 770 180], 'QuantizationInterval', 'lsb');
B(mdl, 'simulink/Discontinuities/Saturation', 'ADXL_range',      [800 150 850 180], ...
  'UpperLimit', 'g_range', 'LowerLimit', '-g_range');
L(mdl, 'to_g/1', 'ADXL_sample/1');
L(mdl, 'ADXL_sample/1', 'add_noise/1');  L(mdl, 'ADXL_noise/1', 'add_noise/2');
L(mdl, 'add_noise/1', 'ADXL_resolution/1');
L(mdl, 'ADXL_resolution/1', 'ADXL_range/1');

% ===== 충격 = | |a + 1g| - 1g |  (파이썬 코드와 같은 정의) =====
B(mdl, 'simulink/Math Operations/Bias', 'plus_gravity',  [890 150 940 180], 'Bias', '1');
B(mdl, 'simulink/Math Operations/Abs',  'magnitude',     [970 150 1010 180]);
B(mdl, 'simulink/Math Operations/Bias', 'minus_gravity', [1040 150 1090 180], 'Bias', '-1');
B(mdl, 'simulink/Math Operations/Abs',  'shock',         [1120 150 1160 180]);
L(mdl, 'ADXL_range/1', 'plus_gravity/1');
L(mdl, 'plus_gravity/1', 'magnitude/1');
L(mdl, 'magnitude/1', 'minus_gravity/1');
L(mdl, 'minus_gravity/1', 'shock/1');

% ===== 충격 점수 = 최근 WINDOW 초 평균 (FIR) =====
B(mdl, 'simulink/Discrete/Discrete Filter', 'score_window_avg', [1200 145 1290 185], ...
  'Numerator', 'ones(1,win_k)/win_k', 'Denominator', '1', 'SampleTime', '1/fs');
L(mdl, 'shock/1', 'score_window_avg/1');

% ===== 감지기: 점수 > 기준값 이고 쿨다운이 끝났으면 1 =====
B(mdl, 'simulink/Sources/Constant', 'threshold', [1230 230 1290 250], 'Value', 'th');
B(mdl, 'simulink/Sources/Constant', 'cooldown',  [1230 280 1290 300], 'Value', 'cooldown_n');
B(mdl, 'simulink/User-Defined Functions/MATLAB Function', 'detector', [1340 160 1440 260]);
code = sprintf([ ...
    'function hit = detector(score, th, cooldown_n)\n' ...
    '%% 점수가 기준값을 넘으면 감지(1). 감지 후 cooldown_n 샘플 동안은 무시\n' ...
    'persistent cnt\n' ...
    'if isempty(cnt)\n' ...
    '    cnt = 0;\n' ...
    'end\n' ...
    'hit = 0;\n' ...
    'if cnt > 0\n' ...
    '    cnt = cnt - 1;\n' ...
    'elseif score > th\n' ...
    '    hit = 1;\n' ...
    '    cnt = cooldown_n;\n' ...
    'end\n']);
rt = sfroot;
ch = rt.find('-isa', 'Stateflow.EMChart', 'Path', [mdl '/detector']);
ch.Script = code;
L(mdl, 'score_window_avg/1', 'detector/1');
L(mdl, 'threshold/1', 'detector/2');
L(mdl, 'cooldown/1',  'detector/3');

% ===== 기록 / 보기 =====
B(mdl, 'simulink/Sinks/To Workspace', 'log_acc',   [900  60 980  80], 'VariableName', 'acc',   'SaveFormat', 'Timeseries');
B(mdl, 'simulink/Sinks/To Workspace', 'log_shock', [1200 60 1280 80], 'VariableName', 'shock', 'SaveFormat', 'Timeseries');
B(mdl, 'simulink/Sinks/To Workspace', 'log_score', [1340 60 1420 80], 'VariableName', 'score', 'SaveFormat', 'Timeseries');
B(mdl, 'simulink/Sinks/To Workspace', 'log_hit',   [1500 160 1580 180], 'VariableName', 'hit',  'SaveFormat', 'Timeseries');
B(mdl, 'simulink/Sinks/Scope',        'Scope',     [1500 230 1540 300], 'NumInputPorts', '3');
L(mdl, 'ADXL_range/1', 'log_acc/1');
L(mdl, 'shock/1', 'log_shock/1');
L(mdl, 'score_window_avg/1', 'log_score/1');
L(mdl, 'detector/1', 'log_hit/1');
L(mdl, 'ADXL_range/1', 'Scope/1');
L(mdl, 'score_window_avg/1', 'Scope/2');
L(mdl, 'detector/1', 'Scope/3');

% ===== 계산 설정: 고정 간격 ode4, 1/fs_sim 초 =====
set_param(mdl, 'SolverType', 'Fixed-step', 'Solver', 'ode4', ...
          'FixedStep', '1/fs_sim', 'StopTime', 't_stop', ...
          'ReturnWorkspaceOutputs', 'on');

save_system(mdl, [mdl '.slx']);
fprintf('Simulink 모델 생성: %s.slx\n', mdl);
try
    add_notes(mdl);       % 설명주석 달기
catch err
    fprintf('주석달기 실패 (모델은 정상): %s\n', err.message);
end
end


function build_wheel(path, pos, z0name)
% 바퀴 하나 2자유도 모델 (적분기로 운동방정식을 그대로 그림)
%   m1 z1'' = kt(zr - z1) + ct(zr' - z1') + kr(z2 - z1) + cr(z2' - z1')
%   m2 z2'' = -kr(z2 - z1) - cr(z2' - z1')
add_block('built-in/Subsystem', path, 'Position', pos);
s = path;
B(s, 'built-in/Inport',  'zr',     [20  40  50  55]);
B(s, 'built-in/Inport',  'zr_dot', [20 110  50 125]);

B(s, 'simulink/Math Operations/Sum', 'tire_dx', [110  35 140  65], 'Inputs', '+-');
B(s, 'simulink/Math Operations/Sum', 'tire_dv', [110 105 140 135], 'Inputs', '+-');
B(s, 'simulink/Math Operations/Sum', 'body_dx', [110 205 140 235], 'Inputs', '+-');
B(s, 'simulink/Math Operations/Sum', 'body_dv', [110 275 140 305], 'Inputs', '+-');

B(s, 'simulink/Math Operations/Gain', 'kt', [180  35 230  65], 'Gain', 'kt');
B(s, 'simulink/Math Operations/Gain', 'ct', [180 105 230 135], 'Gain', 'ct');
B(s, 'simulink/Math Operations/Gain', 'kr', [180 205 230 235], 'Gain', 'kr');
B(s, 'simulink/Math Operations/Gain', 'cr', [180 275 230 305], 'Gain', 'cr');

B(s, 'simulink/Math Operations/Sum',  'F_bike',  [290  70 320 170], 'Inputs', '++++');
B(s, 'simulink/Math Operations/Gain', 'inv_m1',  [350 105 400 135], 'Gain', '1/m1');
B(s, 'simulink/Continuous/Integrator', 'v_bike', [440 105 470 135], 'InitialCondition', '0');
B(s, 'simulink/Continuous/Integrator', 'x_bike', [510 105 540 135], 'InitialCondition', z0name);

B(s, 'simulink/Math Operations/Sum',  'F_rider', [290 230 320 290], 'Inputs', '--');
B(s, 'simulink/Math Operations/Gain', 'inv_m2',  [350 245 400 275], 'Gain', '1/m2');
B(s, 'simulink/Continuous/Integrator', 'v_rider', [440 245 470 275], 'InitialCondition', '0');
B(s, 'simulink/Continuous/Integrator', 'x_rider', [510 245 540 275], 'InitialCondition', z0name);

B(s, 'built-in/Outport', 'a_bike', [600 110 630 125]);

L(s, 'zr/1', 'tire_dx/1');        L(s, 'x_bike/1', 'tire_dx/2');
L(s, 'zr_dot/1', 'tire_dv/1');    L(s, 'v_bike/1', 'tire_dv/2');
L(s, 'x_rider/1', 'body_dx/1');   L(s, 'x_bike/1', 'body_dx/2');
L(s, 'v_rider/1', 'body_dv/1');   L(s, 'v_bike/1', 'body_dv/2');
L(s, 'tire_dx/1', 'kt/1');  L(s, 'tire_dv/1', 'ct/1');
L(s, 'body_dx/1', 'kr/1');  L(s, 'body_dv/1', 'cr/1');
L(s, 'kt/1', 'F_bike/1');   L(s, 'ct/1', 'F_bike/2');
L(s, 'kr/1', 'F_bike/3');   L(s, 'cr/1', 'F_bike/4');
L(s, 'F_bike/1', 'inv_m1/1');
L(s, 'inv_m1/1', 'v_bike/1');
L(s, 'v_bike/1', 'x_bike/1');
L(s, 'inv_m1/1', 'a_bike/1');          % 센서가 재는 것 = 자전거 가속도
L(s, 'kr/1', 'F_rider/1');  L(s, 'cr/1', 'F_rider/2');
L(s, 'F_rider/1', 'inv_m2/1');
L(s, 'inv_m2/1', 'v_rider/1');
L(s, 'v_rider/1', 'x_rider/1');
end


function B(sys, lib, name, pos, varargin)
add_block(lib, [sys '/' name], 'Position', pos, varargin{:});
end

function L(sys, src, dst)
add_line(sys, src, dst, 'autorouting', 'on');
end
