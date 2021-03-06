import {DOM, Element, Node, Text, DocumentFragment, TemplateElement} from 'facade/dom';
import {ListWrapper, MapWrapper, StringMapWrapper, List} from 'facade/collection';
import {ProtoRecordRange, RecordRange, Record,
  ChangeDispatcher, AST, ContextWithVariableBindings} from 'change_detection/change_detection';

import {ProtoElementInjector, ElementInjector, PreBuiltObjects} from './element_injector';
import {ElementBinder} from './element_binder';
import {DirectiveMetadata} from './directive_metadata';
import {SetterFn} from 'reflection/types';
import {FIELD, IMPLEMENTS, int, isPresent, isBlank, BaseException} from 'facade/lang';
import {Injector} from 'di/di';
import {NgElement} from 'core/dom/element';
import {ViewPort} from './viewport';
import {OnChange} from './interfaces';
import {Content} from './shadow_dom_emulation/content_tag';
import {LightDom, DestinationLightDom} from './shadow_dom_emulation/light_dom';

const NG_BINDING_CLASS = 'ng-binding';
const NG_BINDING_CLASS_SELECTOR = '.ng-binding';
// TODO(tbosch): Cannot use `const` because of Dart.
var NO_FORMATTERS = MapWrapper.create();

/**
 * Const of making objects: http://jsperf.com/instantiate-size-of-object
 */
@IMPLEMENTS(ChangeDispatcher)
export class View {
  /// This list matches the _nodes list. It is sparse, since only Elements have ElementInjector
  rootElementInjectors:List<ElementInjector>;
  elementInjectors:List<ElementInjector>;
  bindElements:List<Element>;
  textNodes:List<Text>;
  recordRange:RecordRange;
  /// When the view is part of render tree, the DocumentFragment is empty, which is why we need
  /// to keep track of the nodes.
  nodes:List<Node>;
  componentChildViews: List<View>;
  viewPorts: List<ViewPort>;
  preBuiltObjects: List<PreBuiltObjects>;
  proto: ProtoView;
  context: any;
  contextWithLocals:ContextWithVariableBindings;

  constructor(proto:ProtoView, nodes:List<Node>, protoRecordRange:ProtoRecordRange, protoContextLocals:Map) {
    this.proto = proto;
    this.nodes = nodes;
    this.recordRange = protoRecordRange.instantiate(this, NO_FORMATTERS);
    this.elementInjectors = null;
    this.rootElementInjectors = null;
    this.textNodes = null;
    this.bindElements = null;
    this.componentChildViews = null;
    this.viewPorts = null;
    this.preBuiltObjects = null;
    this.context = null;
    this.contextWithLocals = (MapWrapper.size(protoContextLocals) > 0)
      ? new ContextWithVariableBindings(null, MapWrapper.clone(protoContextLocals))
      : null;
  }

  init(elementInjectors:List, rootElementInjectors:List, textNodes: List, bindElements:List, viewPorts:List, preBuiltObjects:List, componentChildViews:List) {
    this.elementInjectors = elementInjectors;
    this.rootElementInjectors = rootElementInjectors;
    this.textNodes = textNodes;
    this.bindElements = bindElements;
    this.viewPorts = viewPorts;
    this.preBuiltObjects = preBuiltObjects;
    this.componentChildViews = componentChildViews;
  }

  setLocal(contextName: string, value) {
    if (!this.hydrated()) throw new BaseException('Cannot set locals on dehydrated view.');
    if (!MapWrapper.contains(this.proto.variableBindings, contextName)) {
      throw new BaseException(
          `Local binding ${contextName} not defined in the view template.`);
    }
    var templateName = MapWrapper.get(this.proto.variableBindings, contextName);
    this.context.set(templateName, value);
  }

  hydrated() {
    return isPresent(this.context);
  }

  _hydrateContext(newContext) {
    if (isPresent(this.contextWithLocals)) {
      this.contextWithLocals.parent = newContext;
      this.context = this.contextWithLocals;
    } else {
      this.context = newContext;
    }
    // TODO(tbosch): if we have a contextWithLocals we actually only need to
    // set the contextWithLocals once. Would it be faster to always use a contextWithLocals
    // even if we don't have locals and not update the recordRange here?
    this.recordRange.setContext(this.context);
  }

  _dehydrateContext() {
    if (isPresent(this.contextWithLocals)) {
      this.contextWithLocals.clearValues();
    }
    this.context = null;
  }

  /**
   * A dehydrated view is a state of the view that allows it to be moved around
   * the view tree, without incurring the cost of recreating the underlying
   * injectors and watch records.
   *
   * A dehydrated view has the following properties:
   *
   * - all element injectors are empty.
   * - all appInjectors are released.
   * - all viewports are empty.
   * - all context locals are set to null.
   * - the view context is null.
   *
   * A call to hydrate/dehydrate does not attach/detach the view from the view
   * tree.
   */
  hydrate(appInjector: Injector, hostElementInjector: ElementInjector,
      context: Object) {
    if (this.hydrated()) throw new BaseException('The view is already hydrated.');
    this._hydrateContext(context);

    // viewPorts
    for (var i = 0; i < this.viewPorts.length; i++) {
      this.viewPorts[i].hydrate(appInjector, hostElementInjector);
    }

    var binders = this.proto.elementBinders;
    var componentChildViewIndex = 0;
    for (var i = 0; i < binders.length; ++i) {
      var componentDirective = binders[i].componentDirective;
      var shadowDomAppInjector = null;

      // shadowDomAppInjector
      if (isPresent(componentDirective)) {
        var services = componentDirective.annotation.componentServices;
        if (isPresent(services))
          shadowDomAppInjector = appInjector.createChild(services);
        else {
          shadowDomAppInjector = appInjector;
        }
      } else {
        shadowDomAppInjector = null;
      }

      // elementInjectors
      var elementInjector = this.elementInjectors[i];
      if (isPresent(elementInjector)) {
        elementInjector.instantiateDirectives(appInjector, shadowDomAppInjector, this.preBuiltObjects[i]);
      }

      if (isPresent(componentDirective)) {
        this.componentChildViews[componentChildViewIndex++].hydrate(shadowDomAppInjector,
          elementInjector, elementInjector.getComponent());
      }
    }

    // this should be moved into DOM write queue
    for (var i = 0; i < binders.length; ++i) {
      var componentDirective = binders[i].componentDirective;
      if (isPresent(componentDirective)) {
        var lightDom = this.preBuiltObjects[i].lightDom;
        if (isPresent(lightDom)) {
          lightDom.redistribute();
        }
      }
    }
  }

  dehydrate() {
    // Note: preserve the opposite order of the hydration process.

    // componentChildViews
    for (var i = 0; i < this.componentChildViews.length; i++) {
      this.componentChildViews[i].dehydrate();
    }

    // elementInjectors
    for (var i = 0; i < this.elementInjectors.length; i++) {
      if (isPresent(this.elementInjectors[i])) {
        this.elementInjectors[i].clearDirectives();
      }
    }

    // viewPorts
    if (isPresent(this.viewPorts)) {
      for (var i = 0; i < this.viewPorts.length; i++) {
        this.viewPorts[i].dehydrate();
      }
    }

    this._dehydrateContext();
  }

  onRecordChange(groupMemento, records:List<Record>) {
    this._invokeMementoForRecords(records);
    if (groupMemento instanceof DirectivePropertyGroupMemento) {
      this._notifyDirectiveAboutChanges(groupMemento, records);
    }
  }

  _invokeMementoForRecords(records:List<Record>) {
    for(var i = 0; i < records.length; ++i) {
      this._invokeMementoFor(records[i]);
    }
  }

  _notifyDirectiveAboutChanges(groupMemento, records:List<Record>) {
    var dir = groupMemento.directive(this.elementInjectors);
    if (dir instanceof OnChange) {
      dir.onChange(this._collectChanges(records));
    }
  }

    // dispatch to element injector or text nodes based on context
  _invokeMementoFor(record:Record) {
    var memento = record.expressionMemento();
    if (memento instanceof DirectivePropertyMemento) {
      // we know that it is DirectivePropertyMemento
      var directiveMemento:DirectivePropertyMemento = memento;
      directiveMemento.invoke(record, this.elementInjectors);

    } else if (memento instanceof ElementPropertyMemento) {
      var elementMemento:ElementPropertyMemento = memento;
      elementMemento.invoke(record, this.bindElements);

    } else {
      // we know it refers to _textNodes.
      var textNodeIndex:number = memento;
      DOM.setText(this.textNodes[textNodeIndex], record.currentValue);
    }
  }

  _collectChanges(records:List<Record>) {
    var changes = StringMapWrapper.create();
    for(var i = 0; i < records.length; ++i) {
      var record = records[i];
      var propertyUpdate = new PropertyUpdate(record.currentValue, record.previousValue);
      StringMapWrapper.set(changes, record.expressionMemento()._setterName, propertyUpdate);
    }
    return changes;
  }
}

export class ProtoView {
  element:Element;
  elementBinders:List<ElementBinder>;
  protoRecordRange:ProtoRecordRange;
  variableBindings: Map;
  protoContextLocals:Map;
  textNodesWithBindingCount:int;
  elementsWithBindingCount:int;
  instantiateInPlace:boolean;
  rootBindingOffset:int;
  isTemplateElement:boolean;
  constructor(
      template:Element,
      protoRecordRange:ProtoRecordRange) {
    this.element = template;
    this.elementBinders = [];
    this.variableBindings = MapWrapper.create();
    this.protoContextLocals = MapWrapper.create();
    this.protoRecordRange = protoRecordRange;
    this.textNodesWithBindingCount = 0;
    this.elementsWithBindingCount = 0;
    this.instantiateInPlace = false;
    this.rootBindingOffset = (isPresent(this.element) && DOM.hasClass(this.element, NG_BINDING_CLASS))
      ? 1 : 0;
    this.isTemplateElement = this.element instanceof TemplateElement;
  }

  // TODO(rado): hostElementInjector should be moved to hydrate phase.
  instantiate(hostElementInjector: ElementInjector):View {
    var rootElementClone = this.instantiateInPlace ? this.element : DOM.clone(this.element);
    var elementsWithBindingsDynamic;
    if (this.isTemplateElement) {
      elementsWithBindingsDynamic = DOM.querySelectorAll(rootElementClone.content, NG_BINDING_CLASS_SELECTOR);
    } else {
      elementsWithBindingsDynamic= DOM.getElementsByClassName(rootElementClone, NG_BINDING_CLASS);
    }

    var elementsWithBindings = ListWrapper.createFixedSize(elementsWithBindingsDynamic.length);
    for (var i = 0; i < elementsWithBindingsDynamic.length; ++i) {
      elementsWithBindings[i] = elementsWithBindingsDynamic[i];
    }

    var viewNodes;
    if (this.isTemplateElement) {
      var childNode = DOM.firstChild(rootElementClone.content);
      viewNodes = []; // TODO(perf): Should be fixed size, since we could pre-compute in in ProtoView
      // Note: An explicit loop is the fastest way to convert a DOM array into a JS array!
      while(childNode != null) {
        ListWrapper.push(viewNodes, childNode);
        childNode = DOM.nextSibling(childNode);
      }
    } else {
      viewNodes = [rootElementClone];
    }
    var view = new View(this, viewNodes, this.protoRecordRange, this.protoContextLocals);

    var binders = this.elementBinders;
    var elementInjectors = ListWrapper.createFixedSize(binders.length);
    var rootElementInjectors = [];
    var textNodes = [];
    var elementsWithPropertyBindings = [];
    var preBuiltObjects = ListWrapper.createFixedSize(binders.length);
    var viewPorts = [];
    var componentChildViews = [];

    for (var i = 0; i < binders.length; i++) {
      var binder = binders[i];
      var element;
      if (i === 0 && this.rootBindingOffset === 1) {
        element = rootElementClone;
      } else {
        element = elementsWithBindings[i - this.rootBindingOffset];
      }
      var elementInjector = null;

      // elementInjectors and rootElementInjectors
      var protoElementInjector = binder.protoElementInjector;
      if (isPresent(protoElementInjector)) {
        if (isPresent(protoElementInjector.parent)) {
          var parentElementInjector = elementInjectors[protoElementInjector.parent.index];
          elementInjector = protoElementInjector.instantiate(parentElementInjector, null);
        } else {
          elementInjector = protoElementInjector.instantiate(null, hostElementInjector);
          ListWrapper.push(rootElementInjectors, elementInjector);
        }
      }
      elementInjectors[i] = elementInjector;

      if (binder.hasElementPropertyBindings) {
        ListWrapper.push(elementsWithPropertyBindings, element);
      }

      // textNodes
      var textNodeIndices = binder.textNodeIndices;
      if (isPresent(textNodeIndices)) {
        var childNode = DOM.firstChild(DOM.templateAwareRoot(element));
        for (var j = 0, k = 0; j < textNodeIndices.length; j++) {
          for(var index = textNodeIndices[j]; k < index; k++) {
            childNode = DOM.nextSibling(childNode);
          }
          ListWrapper.push(textNodes, childNode);
        }
      }

      // componentChildViews
      var lightDom = null;
      if (isPresent(binder.componentDirective)) {
        var childView = binder.nestedProtoView.instantiate(elementInjector);
        view.recordRange.addRange(childView.recordRange);

        lightDom = binder.componentDirective.shadowDomStrategy.constructLightDom(view, childView, element);
        binder.componentDirective.shadowDomStrategy.attachTemplate(element, childView);

        ListWrapper.push(componentChildViews, childView);
      }

      // viewPorts
      var viewPort = null;
      if (isPresent(binder.templateDirective)) {
        var destLightDom = this._parentElementLightDom(protoElementInjector, preBuiltObjects);
        viewPort = new ViewPort(view, element, binder.nestedProtoView, elementInjector, destLightDom);
        ListWrapper.push(viewPorts, viewPort);
      }

      // preBuiltObjects
      if (isPresent(elementInjector)) {
        preBuiltObjects[i] = new PreBuiltObjects(view, new NgElement(element), viewPort, lightDom);
      }

      // events
      if (isPresent(binder.events)) {
        // TODO(rado): if there is directive at this element that injected an
        // event emitter for that eventType do not attach the handler.
        MapWrapper.forEach(binder.events, (expr, eventName) => {
          DOM.on(element, eventName, (event) => {
            if (event.target === element) {
              // TODO(rado): replace with
              // expr.eval(new ContextWithVariableBindings(view.context, {'$event': event}));
              // when eval with variable bindinds works.
              expr.eval(view.context);
            }
          });
        });
      }
    }

    view.init(elementInjectors, rootElementInjectors, textNodes, elementsWithPropertyBindings,
      viewPorts, preBuiltObjects, componentChildViews);

    return view;
  }

  _parentElementLightDom(protoElementInjector:ProtoElementInjector, preBuiltObjects:List):LightDom {
    var p = protoElementInjector.parent;
    return isPresent(p) ? preBuiltObjects[p.index].lightDom : null;
  }

  bindVariable(contextName:string, templateName:string) {
    MapWrapper.set(this.variableBindings, contextName, templateName);
    MapWrapper.set(this.protoContextLocals, templateName, null);
  }

  bindElement(protoElementInjector:ProtoElementInjector,
      componentDirective:DirectiveMetadata = null, templateDirective:DirectiveMetadata = null):ElementBinder {
    var elBinder = new ElementBinder(protoElementInjector, componentDirective, templateDirective);
    ListWrapper.push(this.elementBinders, elBinder);
    return elBinder;
  }

  /**
   * Adds a text node binding for the last created ElementBinder via bindElement
   */
  bindTextNode(indexInParent:int, expression:AST) {
    var elBinder = this.elementBinders[this.elementBinders.length-1];
    if (isBlank(elBinder.textNodeIndices)) {
      elBinder.textNodeIndices = ListWrapper.create();
    }
    ListWrapper.push(elBinder.textNodeIndices, indexInParent);
    var memento = this.textNodesWithBindingCount++;
    this.protoRecordRange.addRecordsFromAST(expression, memento, memento);
  }

  /**
   * Adds an element property binding for the last created ElementBinder via bindElement
   */
  bindElementProperty(expression:AST, setterName:string, setter:SetterFn) {
    var elBinder = this.elementBinders[this.elementBinders.length-1];
    if (!elBinder.hasElementPropertyBindings) {
      elBinder.hasElementPropertyBindings = true;
      this.elementsWithBindingCount++;
    }
    var memento = new ElementPropertyMemento(this.elementsWithBindingCount-1, setterName, setter);
    this.protoRecordRange.addRecordsFromAST(expression, memento, memento);
  }

  /**
   * Adds an event binding for the last created ElementBinder via bindElement
   */
  bindEvent(eventName:string, expression:AST) {
    var elBinder = this.elementBinders[this.elementBinders.length-1];
    if (isBlank(elBinder.events)) {
      elBinder.events = MapWrapper.create();
    }
    MapWrapper.set(elBinder.events, eventName, expression);
  }

  /**
   * Adds a directive property binding for the last created ElementBinder via bindElement
   */
  bindDirectiveProperty(
    directiveIndex:number,
    expression:AST,
    setterName:string,
    setter:SetterFn,
    isContentWatch: boolean) {

    var expMemento = new DirectivePropertyMemento(
      this.elementBinders.length-1,
      directiveIndex,
      setterName,
      setter
    );
    var groupMemento = DirectivePropertyGroupMemento.get(expMemento);
    this.protoRecordRange.addRecordsFromAST(expression, expMemento, groupMemento, isContentWatch);
  }

  // Create a rootView as if the compiler encountered <rootcmp></rootcmp>,
  // and the component template is already compiled into protoView.
  // Used for bootstrapping.
  static createRootProtoView(protoView: ProtoView,
      insertionElement, rootComponentAnnotatedType: DirectiveMetadata): ProtoView {
    DOM.addClass(insertionElement, 'ng-binding');
    var rootProtoView = new ProtoView(insertionElement, new ProtoRecordRange());
    rootProtoView.instantiateInPlace = true;
    var binder = rootProtoView.bindElement(
        new ProtoElementInjector(null, 0, [rootComponentAnnotatedType.type], true));
    binder.componentDirective = rootComponentAnnotatedType;
    binder.nestedProtoView = protoView;
    return rootProtoView;
  }
}

export class ElementPropertyMemento {
  _elementIndex:int;
  _setterName:string;
  _setter:SetterFn;
  constructor(elementIndex:int, setterName:string, setter:SetterFn) {
    this._elementIndex = elementIndex;
    this._setterName = setterName;
    this._setter = setter;
  }

  invoke(record:Record, bindElements:List<Element>) {
    var element:Element = bindElements[this._elementIndex];
    this._setter(element, record.currentValue);
  }
}

export class DirectivePropertyMemento {
  _elementInjectorIndex:int;
  _directiveIndex:int;
  _setterName:string;
  _setter:SetterFn;
  constructor(
      elementInjectorIndex:number,
      directiveIndex:number,
      setterName:string,
      setter:SetterFn) {
    this._elementInjectorIndex = elementInjectorIndex;
    this._directiveIndex = directiveIndex;
    this._setterName = setterName;
    this._setter = setter;
  }

  invoke(record:Record, elementInjectors:List<ElementInjector>) {
    var elementInjector:ElementInjector = elementInjectors[this._elementInjectorIndex];
    var directive = elementInjector.getAtIndex(this._directiveIndex);
    this._setter(directive, record.currentValue);
  }
}

var _groups = MapWrapper.create();

class DirectivePropertyGroupMemento {
  _elementInjectorIndex:number;
  _directiveIndex:number;

  constructor(elementInjectorIndex:number, directiveIndex:number) {
    this._elementInjectorIndex = elementInjectorIndex;
    this._directiveIndex = directiveIndex;
  }

  static get(memento:DirectivePropertyMemento) {
    var elementInjectorIndex = memento._elementInjectorIndex;
    var directiveIndex = memento._directiveIndex;
    var id = elementInjectorIndex * 100 + directiveIndex;

    if (!MapWrapper.contains(_groups, id)) {
      MapWrapper.set(_groups, id, new DirectivePropertyGroupMemento(elementInjectorIndex, directiveIndex));
    }
    return MapWrapper.get(_groups, id);
  }

  directive(elementInjectors:List<ElementInjector>) {
    var elementInjector:ElementInjector = elementInjectors[this._elementInjectorIndex];
    return elementInjector.getAtIndex(this._directiveIndex);
  }
}

class PropertyUpdate {
  currentValue;
  previousValue;

  constructor(currentValue, previousValue) {
    this.currentValue = currentValue;
    this.previousValue = previousValue;
  }
}
