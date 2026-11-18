function add_notes(mdl)
% 모델에 설명주석 달기 (모델 새로 안만들고 지금있는거에 붙임)
%   add_notes                → bike_pothole_model 에 주석달고 저장함
%   다시 실행하면 전에 이 스크립트가 단 주석만 지우고 새로 닮 (직접 쓴 주석은 그대로)
%   주석 내용 바꾸고싶으면 아래 글만 고치면됨
if nargin < 1, mdl = 'bike_pothole_model'; end
load_system(mdl);
wheel = {[mdl '/Front_wheel'], [mdl '/Rear_wheel']};
clear_notes(mdl);
for i = 1:2, clear_notes(wheel{i}); end

nl = newline;

% ===== 최상위 =====
note(mdl, ['자전거포트홀감지 시뮬레이션' nl ...
           '노면→자전거·사람진동→ADXL345→충격점수→감지 순서로흘러감' nl ...
           '실행은 step1_demo.m 으로해야함 (변수랑노면데이터를 스크립트가넣어줌)'], 20, -90, 14);

note(mdl, ['①노면입력' nl ...
           '앞바퀴(f)뒷바퀴(r)가밟는' nl '노면높이랑변화속도넣음' nl ...
           '뒷바퀴는1.05m늦게지나감' nl '→방지턱하나에충격두번옴'], 20, 330);

note(mdl, ['②바퀴진동계산' nl ...
           '바퀴하나를2자유도로봄' nl '(자전거+타이어/사람+팔다리)' nl ...
           '더블클릭하면안에식보임' nl '출력=자전거몸체가속도'], 160, 450);

note(mdl, ['③앞뒤섞기' nl ...
           '센서가핸들쪽이라' nl '앞70%뒤30%로섞음' nl ...
           '9.81로나눠서g단위로바꿈'], 330, 330);

note(mdl, ['④ADXL345센서흉내' nl ...
           '400Hz로만읽음(0x2C=0x0C)' nl '잡음0.01g더함' nl ...
           '3.9mg단위로잘림' nl '±16g넘으면잘림(0x31=0x0B)'], 580, 450);

note(mdl, ['⑤충격계산' nl ...
           '+1로중력넣고크기구하고' nl '-1로중력빼고절댓값씌움' nl ...
           '=파이썬 abs(sqrt(x²+y²+z²)-1)이랑같음'], 880, 330);

note(mdl, ['⑥충격점수' nl ...
           '최근0.05초(20개)평균냄' nl '한번튀는잡음무시하려고함' nl ...
           '=파이썬 WINDOW'], 1180, 450);

note(mdl, ['⑦감지기' nl ...
           '점수가기준값(th)넘으면1' nl '감지하면2초(800개)동안무시함' nl ...
           '=같은구멍두번안셈 (COOLDOWN)'], 1330, 330);

note(mdl, ['⑧결과' nl ...
           'out.~ 은스크립트가가져가서' nl '그래프,실측비교,기준값추천함' nl ...
           'Scope더블클릭하면' nl '센서값/점수/감지신호같이보임'], 1500, 450);

% ===== 바퀴 서브시스템 안 =====
for i = 1:2
    s = wheel{i};
    note(s, ['바퀴하나 2자유도모델' nl ...
             '아래=자전거(m1)+타이어(kt,ct)' nl '위=사람(m2)+팔다리(kr,cr)' nl ...
             'm1·z1'''' = kt(zr-z1)+ct(zr''-z1'')+kr(z2-z1)+cr(z2''-z1'')' nl ...
             'm2·z2'''' = -kr(z2-z1)-cr(z2''-z1'')'], 20, -110, 13);
    note(s, ['위치차이,속도차이구해서' nl '스프링(k)댐퍼(c)곱하면힘나옴'], 100, 330);
    note(s, ['힘다더하고질량으로나누면가속도' nl '적분두번하면 속도→위치' nl ...
             '위치는다시앞으로돌아가서힘계산함'], 290, 330);
    note(s, ['센서가재는거' nl '=자전거가속도임'], 560, 150);
end

save_system(mdl);
fprintf('주석달고저장함: %s.slx\n', mdl);
end


function note(sys, txt, x, y, fsize)
% 주석하나달기. 글자수보고 상자크기 대충맞춤
if nargin < 5, fsize = 11; end
lines = strsplit(txt, newline);
w = max(cellfun(@numel, lines)) * fsize * 1.1 + 20;
h = numel(lines) * fsize * 1.6 + 10;
try
    a = Simulink.Annotation(sys, txt);
    a.Position = [x y x + w y + h];
    try a.FontSize = fsize; catch, end
    try a.BackgroundColor = '[1 0.98 0.85]'; catch, end
    try a.Tag = 'auto_note'; catch, end
catch
    % 옛날버전용
    try
        h_ = add_block('built-in/Note', [sys '/' strrep(txt, '/', '//')], 'Position', [x y]);
        try set_param(h_, 'Tag', 'auto_note'); catch, end
    catch err
        fprintf('주석하나못담: %s\n', err.message);
    end
end
end


function clear_notes(sys)
% 전에 이스크립트가 단 주석만 지움
h = find_system(sys, 'FindAll', 'on', 'SearchDepth', 1, 'Type', 'annotation', 'Tag', 'auto_note');
for k = 1:numel(h)
    try delete(get_param(h(k), 'Object')); catch, end
end
end
