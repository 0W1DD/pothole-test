function out = run_simulink_model(p, t, zf, zr, seed)
% Simulink 모델(bike_pothole_model.slx)로 한 번 주행시키기
%   t      : 노면 시간 (1/fs_sim 간격)
%   zf, zr : 앞바퀴, 뒷바퀴가 밟는 노면 높이 (m)
% 돌려주는 값은 simulate_ride 와 같은 형식 (t, acc, shock, score) + tdet (Simulink 감지기 결과)

mdl = 'bike_pothole_model';
build_bike_model(false);          % 모델 파일이 없으면 만들기
load_system(mdl);

dt = 1 / p.fs_sim;
t  = t(:); zf = zf(:); zr = zr(:);

% 모델 블록들이 쓰는 변수를 base 작업공간에 넣기
v = struct();
v.zf_data  = [t, zf];
v.zfd_data = [t, gradient(zf, dt)];
v.zr_data  = [t, zr];
v.zrd_data = [t, gradient(zr, dt)];
v.z0_front = zf(1);               % 처음엔 노면 위에 가만히 있는 상태
v.z0_rear  = zr(1);
v.m1 = p.m1;  v.m2 = p.m2;
v.kt = p.kt;  v.ct = p.ct;
v.kr = p.kr;  v.cr = p.cr;
v.wf = p.wf;
v.fs = p.fs;  v.fs_sim = p.fs_sim;
v.noise = p.noise;  v.noise_seed = seed + 100;
v.lsb = p.lsb;      v.g_range = p.range;
v.win_k = max(1, round(p.window * p.fs));
v.th = p.threshold;
v.cooldown_n = round(p.cooldown * p.fs);
v.t_stop = t(end);
names = fieldnames(v);
for i = 1:numel(names)
    assignin('base', names{i}, v.(names{i}));
end

so = sim(mdl, 'ReturnWorkspaceOutputs', 'on');

acc   = so.get('acc');
shock = so.get('shock');
score = so.get('score');
hit   = so.get('hit');

out.t     = acc.Time(:);
out.acc   = squeeze(acc.Data);
out.shock = squeeze(shock.Data);
out.score = squeeze(score.Data);
h         = squeeze(hit.Data);
out.tdet  = hit.Time(h > 0.5);
out.acc = out.acc(:); out.shock = out.shock(:); out.score = out.score(:);
end
