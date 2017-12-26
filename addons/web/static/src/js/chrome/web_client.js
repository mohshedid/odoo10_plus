flectra.define('web.WebClient', function (require) {
"use strict";

var AbstractWebClient = require('web.AbstractWebClient');
var core = require('web.core');
var data_manager = require('web.data_manager');
var framework = require('web.framework');
var Menu = require('web.Menu');
var session = require('web.session');
var SystrayMenu = require('web.SystrayMenu');
var UserMenu = require('web.UserMenu');
var UserProfile = require('web.UserProfile');
var config = require('web.config');
var bus = require('builder.bus');

return AbstractWebClient.extend({
    events: {
        'click .oe_logo_edit_admin': 'logo_edit',
        'click .oe_logo img': function(ev) {
            ev.preventDefault();
            return this.clear_uncommitted_changes().then(function() {
                framework.redirect("/web" + (core.debug ? "?debug" : ""));
            });
        },
    },
    //builder custom events
    custom_events: _.extend({}, AbstractWebClient.prototype.custom_events, {
        'open_app_builder': '_on_app_builder_open',
        'on_new_app_create': '_on_build_app'
    }),
    //builder init
    init: function () {
        var self = this;
        self._super.apply(this, arguments);
        self.app_builder_status = false;
        bus.on('app_builder_toggled', this, function (status) {
            self.app_builder_status = status;
        });
    },
    show_application: function() {
        var self = this;
        var qs = $.deparam.querystring();

        // Allow to call `on_attach_callback` and `on_detach_callback` when needed
        this.action_manager.is_in_DOM = true;

        this.toggle_bars(true);
        this.set_title();
        this.update_logo();

        // Menu is rendered server-side thus we don't want the widget to create any dom
        this.menu = new Menu(this);
        this.menu.setElement(this.$el.parents().find('.oe_application_menu_placeholder'));
        this.menu.on('menu_click', this, this.on_menu_action);
        if (config.device.size_class < config.device.SIZES.SM) {
            this.menu.is_menus_lite_mode = false;
        }else{
            this.menu.is_menus_lite_mode = 'menus_lite_mode' in window.sessionStorage ? true : false;
        }

        // Create the user menu (rendered client-side)
        this.user_menu = new UserMenu(this);
        this.user_profile = new UserProfile(this);
        var $user_menu_placeholder = $('body').find('.oe_user_menu_placeholder').show();
        var $oe_application_menu_placeholder = $('body').find('.f_launcher_content');
        var user_menu_loaded = this.user_menu.appendTo($user_menu_placeholder);
        this.user_profile.prependTo($oe_application_menu_placeholder);

        // Create the systray menu (rendered server-side)
        this.systray_menu = new SystrayMenu(this);
        this.systray_menu.setElement(this.$el.parents().find('.oe_systray'));
        var systray_menu_loaded = this.systray_menu.start();

        //builder access check
        if (!session.is_system) {
            if (qs.app_builder !== undefined) {
                self.do_warn("Access Denied", "Flectra App Builder Requires Access To Admin Account or Requires Appropriate Rights!.");
                delete qs.app_builder;
                var l = window.location;
                var url = l.protocol + "//" + l.host + l.pathname + '?' + $.param(qs) + l.hash;
                window.history.pushState({path: url}, '', url);
            }
        }

        // Start the menu once both systray and user menus are rendered
        // to prevent overflows while loading
        return $.when(systray_menu_loaded, user_menu_loaded).then(function() {
            self.menu.start();
            self.bind_hashchange();
            self.app_builder_status = _.contains(['main', 'app_creator'], qs.app_builder) ? qs.app_builder : false;
            if (self.app_builder_status === 'app_creator') {
                self.trigger_up('open_app_builder', {'status': self.app_builder_status});
            }
        });

    },
    toggle_bars: function(value) {
        this.$('tr:has(td.navbar),.oe_leftbar').toggle(value);
    },
    update_logo: function(reload) {
        var company = session.company_id;
        var img = session.url('/web/binary/company_logo' + '?db=' + session.db + (company ? '&company=' + company : ''));
        this.$('.o_sub_menu_logo img').attr('src', '').attr('src', img + (reload ? "#" + Date.now() : ''));
        this.$('.oe_logo_edit').toggleClass('oe_logo_edit_admin', session.is_superuser);
    },
    logo_edit: function(ev) {
        var self = this;
        ev.preventDefault();
        this._rpc({
                model: 'res.users',
                method: 'read',
                args: [[session.uid], ['company_id']],
            })
            .then(function(data) {
                self._rpc({
                        route: '/web/action/load',
                        params: { action_id: 'base.action_res_company_form' },
                    })
                    .done(function(result) {
                        result.res_id = data[0].company_id[0];
                        result.target = "new";
                        result.views = [[false, 'form']];
                        result.flags = {
                            action_buttons: true,
                            headless: true,
                        };
                        self.action_manager.do_action(result).then(function () {
                            var form = self.action_manager.dialog_widget.views.form.controller;
                            form.on("on_button_cancel", self.action_manager, self.action_manager.dialog_stop);
                            form.on('record_saved', self, function() {
                                self.action_manager.dialog_stop();
                                self.update_logo();
                            });
                        });
                    });
            });
        return false;
    },
    bind_hashchange: function() {
        var self = this;
        $(window).bind('hashchange', this.on_hashchange);

        var state = $.bbq.getState(true);
        if (_.isEmpty(state) || state.action === "login") {
            self.menu.is_bound.done(function() {
                self._rpc({
                        model: 'res.users',
                        method: 'read',
                        args: [[session.uid], ['action_id']],
                    })
                    .done(function(result) {
                        var data = result[0];
                        if(data.action_id) {
                            self.action_manager.do_action(data.action_id[0]);
                            self.menu.open_action(data.action_id[0]);
                        } else {
                            var first_menu_id = self.menu.$el.find("a:first").data("menu");
                            if(first_menu_id) {
                                self.menu.menu_click(first_menu_id);
                            }
                        }
                    });
            });
        } else {
            $(window).trigger('hashchange');
        }
    },
    on_hashchange: function(event) {
        if (this._ignore_hashchange) {
            this._ignore_hashchange = false;
            return;
        }

        var self = this;
        this.clear_uncommitted_changes().then(function () {
            var stringstate = event.getState(false);
            if (!_.isEqual(self._current_state, stringstate)) {
                var state = event.getState(true);
                if(!state.action && state.menu_id) {
                    self.menu.is_bound.done(function() {
                        self.menu.menu_click(state.menu_id);
                    });
                } else {
                    state._push_me = false;  // no need to push state back...
                    self.action_manager.do_load_state(state, !!self._current_state).then(function () {
                        var action = self.action_manager.get_inner_action();
                        if (action) {
                            self.menu.open_action(action.action_descr.id);
                        }
                    });
                }
            }
            self._current_state = stringstate;
        }, function () {
            if (event) {
                self._ignore_hashchange = true;
                window.location = event.originalEvent.oldURL;
            }
        });
    },
    on_menu_action: function(options) {
        var self = this;
        return this.menu_dm.add(data_manager.load_action(options.action_id))
            .then(function (result) {
                return self.action_mutex.exec(function() {
                    var completed = $.Deferred();
                    $.when(self.action_manager.do_action(result, {
                        clear_breadcrumbs: true,
                        action_menu_id: self.menu.current_menu,
                    })).fail(function() {
                        self.menu.open_menu(options.previous_menu_id);
                    }).always(function() {
                        completed.resolve();
                    });
                    setTimeout(function() {
                        completed.resolve();
                    }, 2000);
                    // We block the menu when clicking on an element until the action has correctly finished
                    // loading. If something crash, there is a 2 seconds timeout before it's unblocked.
                    return completed;
                });
            });
    },
    toggle_fullscreen: function(fullscreen) {
        this._super(fullscreen);
        if (!fullscreen) {
            this.menu.reflow();
        }
    },
    //builder methods
    fetch_app_builder: function (action) {
        var arr = [];
        if (action) {
            this.res_id = action.widget.env.currentId;
            if (this.app_builder_status) {
                arr.push(this.open_app_builder(this.app_builder_status, {action: action}));
            }
        }
    },

    _on_app_builder_open: function (ev) {
        var self = this;
        this.app_builder_status = ev.data.status || 'main'; // Checks weather we are in app_builder mode or not
        var action = this.action_manager.get_inner_action(); // action object for having views,model,xml description
        var action_desc = action && action.action_descr || null;
        var active_view = action && action.get_active_view();
        var def_obj = self.fetch_app_builder(action);
        return $.when.apply($, def_obj).then(function () {
            bus.trigger('app_builder_toggled', self.app_builder_status, action_desc, active_view);
        });
    },

    open_app_builder: function (mode, options) {
        options = options || {};
        var def_obj = [];
        var self = this;
        var act = options.action;
        this.app_builder_status = mode;
        var reborn_options = {
            clear_breadcrumbs: true
        };
        _.extend(reborn_options, options);
        if (act) {
            if (!options.active_view) {
                reborn_options.active_view = act.get_active_view();
            } else {
                reborn_options.active_view = options.active_view;
                def_obj.push(act.widget.switch_mode(options.active_view));
            }
            reborn_options.action = act.action_descr;
        }
        return $.when.apply($, def_obj).then(function () {
            return self.do_action('action_web_' + mode, reborn_options);
        });
    },

    _on_build_app: function (ev) {
        var data = {
            "type": "ir.actions.act_window",
            "res_model": ev.data.model_name,
            'menu_id': ev.data.menu_id,
            'id': ev.data.action_id,
            'res_id': 1,
            "views": [[false, "list"], [false, "form"]],
            "view_mode":'list,form'
        };
        bus.trigger('app_builder_toggled', 'main');
        this.do_action(data, {
            view_type: 'form',
            action_manager: this.action_manager
        });
    },
    do_action: function (action, options) {
        if (this.app_builder_status === 'main' &&
            this.action_manager.get_inner_action().widget.active_view !== undefined) {
            options = options || {};
            if (this.res_id !== undefined) {
                options.action.res_id = this.res_id;
            }
            options.active_view = this.action_manager.get_inner_action().widget.active_view;
            options.view_env = this.action_manager.get_inner_action().widget.env;
        }
        return this._super.apply(this, arguments);
    }
});

});
